import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Workspace, WorkspaceScope, Endpoint, Anchor, WorkspaceAgent, AgentMessage, Id, Located, FlowUI } from '@bal-bot/workspace';
import type { AgentScope } from '@bal-bot/browser-workspace';
import { Accounts } from './accounts';
import { AnchorButton } from './anchor-button';
import { getAccounts, type ProviderAccount } from './providers';
import { FileTree } from './file-tree';
import { FlowView } from './flow-view';
import { ReferenceChips } from './reference-chips';
import { addReference, removeReference, refreshReferences, serializePrompt, type ChatDraft } from './references';
import type { ExpansionPath } from './hir-diagram';
import { conversationItems } from './tool-summaries';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

function messageText(message: AgentMessage): string {
  const text = typeof message.content === 'string' ? message.content : message.content.map(part => part.type === 'text' ? part.text : '').filter(Boolean).join('\n');
  if (message.role !== 'user' || !text.includes('<workspace-scope>')) return text;
  const prose = text.split('<workspace-scope>')[0].trimEnd();
  try { const entries = JSON.parse(text.split('<source-references>\n')[1].split('\n</source-references>')[0]) as {label: string}[]; return [prose, ...entries.map(e => e.label)].filter(Boolean).join('\n'); } catch { return text; }
}
function EndpointLabel({endpoint}: {endpoint: Endpoint}): React.JSX.Element {
  const separator = endpoint.kind === 'resource' ? endpoint.title.indexOf(' ') : -1;
  return <><small className="text-[10px] text-muted-foreground">{endpoint.kind}</small><span className="endpoint-label">{separator > 0 ? <><span className="endpoint-operation mr-1.5 inline-block bg-muted px-1 py-0.5 text-[10px] font-bold uppercase leading-snug text-foreground">{endpoint.title.slice(0, separator)}</span>{' '}{endpoint.title.slice(separator + 1)}</> : endpoint.title}</span></>;
}
interface AnchorView { readonly draft: ChatDraft; readonly expanded: ReadonlySet<ExpansionPath>; readonly inspectedFunction?: Id; }
const emptyView: AnchorView = {draft: {text: '', references: []}, expanded: new Set()};
const DISCLAIMER = 'ballerina-agent (beta) runs entirely in your browser. Your conversation and API keys are ephemeral and never stored.';
export function Editor({workspace}: {workspace: Workspace}): React.JSX.Element {
  const files = useSyncExternalStore(listener => workspace.subscribe(listener), () => workspace.snapshot());
  const storage = useSyncExternalStore(workspace.subscribeStorage, workspace.storageSnapshot);
  const writable = () => workspace.storageSnapshot().writable;
  const analysis = useSyncExternalStore(workspace.subscribeAnalysis, workspace.analysisSnapshot);
  const projectName = workspace.projectName ?? 'Workspace';
  const [scopes, setScopes] = useState<readonly WorkspaceScope[]>([]), [anchorId, setAnchorId] = useState<Id | null>(null);
  const anchors: Anchor[] = scopes.flatMap<Anchor>(s => s.scopeKind === 'service' ? [s, ...s.getEndpoints()] : [s]);
  const anchor = anchors.find(a => a.id === anchorId) ?? null;
  const [views, setViews] = useState<Map<Anchor, AnchorView>>(() => new Map());
  const view = anchor ? views.get(anchor) ?? emptyView : emptyView;
  const draft = refreshReferences(view.draft, analysis, files);
  const updateView = (update: (view: AnchorView) => AnchorView, selectedAnchor = anchor) => { if (selectedAnchor) setViews(all => new Map(all).set(selectedAnchor, update(all.get(selectedAnchor) ?? emptyView))); };
  const [flow, setFlow] = useState<FlowUI | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false), [selected, setSelected] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]), [provider, setProvider] = useState('openai'), [model, setModel] = useState(''), [loginRequest, setLoginRequest] = useState(0);
  const [messages, setMessages] = useState<AgentMessage[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState(workspace.storageSnapshot().error ?? '');
  const agent = useRef<WorkspaceAgent | null>(null);
  const [compactionState, setCompactionState] = useState<WorkspaceAgent['compactionState']>('idle');
  const selectedAnchorRef = useRef(anchor); selectedAnchorRef.current = anchor;
  const [newPath, setNewPath] = useState(''), [creating, setCreating] = useState(false), [deletePending, setDeletePending] = useState(false);
  const activeFile = selected !== null && Object.hasOwn(files, selected) ? selected : null;
  const [sourceDraft, setSourceDraft] = useState(''), [editing, setEditing] = useState(false);
  const [inspectionExpanded, setInspectionExpanded] = useState(false), [chatPosition, setChatPosition] = useState({x: 24, y: 24});
  const workspaceElement = useRef<HTMLDivElement>(null);
  const drag = useRef<{x: number; y: number; left: number; top: number} | null>(null);
  const clampChat = (point: {x: number; y: number}) => { const rect = workspaceElement.current?.getBoundingClientRect(); return {x: Math.max(0, Math.min(point.x, (rect?.width ?? 440) - Math.min(420, rect?.width ?? 420))), y: Math.max(0, Math.min(point.y, (rect?.height ?? 520) - Math.min(480, rect?.height ?? 480)))}; };
  useEffect(() => { const observer = new ResizeObserver(() => setChatPosition(p => clampChat(p))); if (workspaceElement.current) observer.observe(workspaceElement.current); return () => observer.disconnect(); }, []);
  useEffect(() => {
    let disposed = false;
    void workspace.getScopes().then(items => { if (disposed) return; setScopes(items);
      const ids = items.flatMap(s => s.scopeKind === 'service' ? [s.id, ...s.getEndpoints().map(e => e.id)] : [s.id]);
      setAnchorId(id => id && ids.includes(id) ? id : items[0]?.id ?? null);
    }).catch(e => { if (!disposed) setError(String(e)); });
    return () => { disposed = true; };
  }, [workspace, analysis]);
  useEffect(() => {
    const controller = new AbortController(); setFlow(null);
    if (anchor) void anchor.getFlowUI(controller.signal).then(result => { if (!controller.signal.aborted) setFlow(result); }).catch(e => { if (!controller.signal.aborted) setError(String(e)); });
    return () => controller.abort();
  }, [anchor, analysis]);
  useEffect(() => {
    let disposed = false; let unsubscribe: (() => void) | undefined, unsubscribeCompaction: (() => void) | undefined;
    agent.current = null; setMessages([]); setBusy(false); setCompactionState('idle');
    if (anchor) void anchor.getAgent().then(current => {
      if (disposed) return; agent.current = current;
      const update = () => { if (disposed || selectedAnchorRef.current !== anchor) return; setMessages([...current.state.messages, ...(current.state.streamingMessage ? [current.state.streamingMessage] : [])]); setBusy(current.state.isStreaming || current.compactionState === 'compacting'); setCompactionState(current.compactionState); };
      update(); unsubscribe = current.subscribe(() => update()); unsubscribeCompaction = current.subscribeCompaction(update);
    }).catch(e => { if (!disposed) setError(String(e)); });
    return () => { disposed = true; unsubscribe?.(); unsubscribeCompaction?.(); };
  }, [anchor]);
  async function refreshAccounts() { setAccounts(await getAccounts()); }
  useEffect(() => { void refreshAccounts().catch(e => setError(String(e))); }, []);
  const providerModels = accounts.find(a => a.id === provider)?.models ?? [], activeModel = providerModels.find(m => m.id === model) ?? providerModels[0];
  function openFile(path: string) { setSelected(path); setEditing(false); setDeletePending(false); }
  function attempt(action: () => void) { try {action(); setError('');} catch (e) {setError(String(e));} }
  function chooseAnchor(id: Id) { setAnchorId(id); setSelected(null); setEditing(false); }
  function toggleExpansion(path: ExpansionPath): void { updateView(v => { const expanded = new Set(v.expanded); if (expanded.has(path)) expanded.delete(path); else expanded.add(path); return {...v, expanded}; }); }
  function selectNode(node: Located): void { const state = workspace.analysisSnapshot(); if (state.kind !== 'ready') return; updateView(v => ({...v, draft: addReference(refreshReferences(v.draft, state, workspace.snapshot()), node, state.revision)})); }
  function openFunction(id: Id): void { updateView(v => ({...v, inspectedFunction: id})); }
  async function send(): Promise<void> {
    if ((!draft.text.trim() && !draft.references.length) || busy || compactionState === 'failed' || !anchor || !writable()) return;
    if (!accounts.find(a => a.id === provider)?.connected || !activeModel) { setLoginRequest(v => v + 1); return; }
    const selectedAnchor = anchor, capturedRevision = workspace.analysisSnapshot().revision;
    setBusy(true); setError(''); setSelected(null);
    try {
      const current = await selectedAnchor.getAgent();
      if (['compacting', 'failed'].includes(current.compactionState)) return;
      current.state.model = activeModel;
      const state = workspace.analysisSnapshot(), snapshot = workspace.snapshot();
      if ((draft.references.length > 0 && (state.kind !== 'ready' || state.revision !== capturedRevision)) || !writable()) throw new Error('Saved source changed. Review the current references and send again.');
      const currentProgram = state.kind === 'ready' ? state.program : state.previous;
      const scope = currentProgram?.scopes.find(s => s.id === selectedAnchor.id);
      const endpointScope = currentProgram?.scopes.find(s => s.kind === 'service' && s.endpoints.some(e => e.id === selectedAnchor.id));
      const endpoint = endpointScope?.kind === 'service' ? endpointScope.endpoints.find(e => e.id === selectedAnchor.id) : undefined;
      const selectedScope = scope ?? endpoint; if (!selectedScope) throw new Error('This scope is no longer in the saved source.');
      const context: AgentScope = {id: selectedScope.id, title: selectedScope.title, source: selectedScope.source, kind: scope?.kind ?? 'endpoint'};
      const input = serializePrompt(draft, state, snapshot, context);
      const pending = current.prompt(input);
      updateView(v => v.draft.text === draft.text && v.draft.references.map(r => r.id).join('\0') === draft.references.map(r => r.id).join('\0') ? {...v, draft: {text: '', references: []}} : v, selectedAnchor);
      await pending;
      if (current.state.errorMessage && current.compactionState !== 'failed' && selectedAnchorRef.current === selectedAnchor) setError(current.state.errorMessage);
    } catch (e) { setError(String(e)); } finally { if (selectedAnchorRef.current === selectedAnchor) setBusy(false); }
  }
  const visibleFlow = flow ? {...flow, state: analysis, ...(view.inspectedFunction ? {selection: {kind: 'function' as const, functionId: view.inspectedFunction}} : {})} : null;
  const showingFlow = visibleFlow?.selection.kind === 'function' && !!(analysis.kind === 'ready' ? analysis.program : analysis.previous);
  useEffect(() => { if (!showingFlow) setInspectionExpanded(false); }, [showingFlow]);
  const conversation = conversationItems(messages, busy);
  const composer = <><div className="conversation min-h-0 flex-1 overflow-auto p-6" ref={element => {if (element) element.scrollTop = element.scrollHeight;}}>{!conversation.length && <div className="welcome max-w-sm pt-8"><h1 className="mb-2 text-lg font-medium">What shall we build?</h1><p className="text-muted-foreground">Describe a change or attach source from the flow.</p></div>}{conversation.map((item,i) => item.kind === 'tool' ? <div key={`tool-${item.id}`} className={`tool-summary tool-${item.state} mb-3 break-words text-[11px] leading-relaxed ${item.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>{item.text}</div> : <article key={i} className={`message ${item.message.role} mb-5 text-sm leading-relaxed ${item.message.role === 'user' ? 'border bg-muted px-4 py-3' : ''}`}><div className="message-label mb-1 text-[10px] font-bold text-muted-foreground">{item.message.role === 'user' ? 'You' : 'bal-bot'}</div><div className="message-body">{item.message.role === 'assistant' ? <Markdown remarkPlugins={[remarkGfm]}>{messageText(item.message)}</Markdown> : <pre className="m-0 whitespace-pre-wrap break-words font-[inherit]">{messageText(item.message)}</pre>}</div>{item.message.role === 'assistant' && item.message.errorMessage && <p className="message-error text-destructive">{item.message.errorMessage}</p>}</article>)}</div><div className="composer-area flex-none px-4 pb-4">{(busy || compactionState === 'compacting') && <div className="activity mb-2 text-[11px] text-muted-foreground" role="status">{compactionState === 'compacting' ? 'Compacting conversation…' : 'working...'}</div>}<form className="composer border bg-background p-3" onSubmit={event => {event.preventDefault(); void send();}}><ReferenceChips draft={draft} onRemove={id => updateView(v => ({...v, draft: removeReference(v.draft, id)}))}/><Textarea className="min-h-14 resize-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-0 dark:bg-transparent" aria-label="Message" disabled={compactionState === 'failed'} placeholder="Describe a change…" value={draft.text} onChange={e => updateView(v => ({...v, draft: {...v.draft, text: e.target.value}}))} onKeyDown={e => {if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {e.preventDefault(); void send();}}}/><div className="composer-bottom mt-2 flex items-center justify-between gap-2"><label className="composer-model min-w-0"><span className="sr-only">Model</span><select className="h-7 min-w-0 max-w-64 truncate border bg-background px-1.5 text-[11px] text-muted-foreground disabled:opacity-50" aria-label="Model" value={activeModel?.id ?? ''} disabled={busy || !providerModels.length} onChange={e => setModel(e.target.value)}>{!providerModels.length && <option value="">Loading models…</option>}{providerModels.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>{busy ? <Button type="button" variant="outline" size="sm" onClick={() => agent.current?.abort()}>Stop ■</Button> : <Button type="submit" size="icon-sm" aria-label="Send message" disabled={compactionState === 'failed' || (!draft.text.trim() && !draft.references.length) || !storage.writable || draft.references.some(r => r.stale)}>↑</Button>}</div></form></div></>;
  return <div className="app flex h-full flex-col bg-background text-xs text-foreground"><header className="relative z-10 flex h-11 flex-none items-center justify-between gap-2 border-b px-3"><p className="disclaimer min-w-0 truncate border border-primary/40 bg-primary/10 px-2.5 py-1 text-xs font-medium text-foreground" title={DISCLAIMER}>{DISCLAIMER}</p><Accounts accounts={accounts} provider={provider} busy={busy} chooseProvider={id => {setProvider(id);setModel('');}} refresh={refreshAccounts} loginRequest={loginRequest}/></header>
    <div ref={workspaceElement} className={`workspace flow-workspace min-h-0 flex-1 ${inspectionExpanded ? 'inspection-expanded' : ''}`}>
      <aside id="workspace-sidebar" className={`flex flex-col overflow-auto border-r bg-sidebar p-3 text-sidebar-foreground ${sidebarCollapsed ? 'collapsed' : ''}`}><div className="sidebar-heading mb-3 flex min-h-8 items-center justify-between"><span className="text-[10px] font-semibold tracking-widest text-muted-foreground">WORKSPACE</span><Button variant="ghost" size="icon-xs" aria-label={sidebarCollapsed ? 'Expand workspace sidebar' : 'Collapse workspace sidebar'} onClick={() => setSidebarCollapsed(!sidebarCollapsed)}>☰</Button></div><div hidden={sidebarCollapsed} className="sidebar-content flex min-h-0 flex-1 flex-col overflow-auto"><div className="project mb-2 text-xs font-semibold">{projectName}</div>{scopes.map(scope => <React.Fragment key={scope.id}><AnchorButton anchor={scope} className={`service w-full px-3 py-2 text-left text-xs ${anchorId === scope.id ? 'selected bg-accent text-accent-foreground' : 'hover:bg-muted'}`} data-scope-id={scope.id} onChoose={() => chooseAnchor(scope.id)}>{scope.title}{scope.scopeKind === 'service' && <small>{scope.kind ?? 'Service'}</small>}{scope.scopeKind === 'automation' && scopes.length > 1 && <small>{scope.id.split('/function/')[0]}</small>}</AnchorButton>{scope.scopeKind === 'service' && scope.getEndpoints().map(endpoint => <AnchorButton key={endpoint.id} anchor={endpoint} className={`endpoint w-full text-left text-xs ${anchorId === endpoint.id ? 'selected bg-accent text-accent-foreground' : 'hover:bg-muted'}`} onChoose={() => chooseAnchor(endpoint.id)}><EndpointLabel endpoint={endpoint}/></AnchorButton>)}</React.Fragment>)}<div className="section-title file-heading mt-6 mb-2 flex items-center justify-between text-[10px] font-semibold tracking-widest text-muted-foreground">FILES<Button variant="ghost" size="icon-xs" disabled={!storage.writable} aria-label="New file" onClick={() => setCreating(!creating)}>+</Button></div>{creating && <form className="new-file mb-2 flex gap-1" onSubmit={event => {event.preventDefault();attempt(() => {if (Object.hasOwn(files,newPath)) throw new Error('File already exists');workspace.write(newPath,'');openFile(newPath);setNewPath('');setCreating(false);});}}><Input className="h-7 min-w-0 text-xs" aria-label="New file path" disabled={!storage.writable} value={newPath} onChange={e => setNewPath(e.target.value)} autoFocus/><Button type="submit" size="sm" disabled={!storage.writable}>Add</Button></form>}<FileTree paths={workspace.list()} selected={selected} open={openFile}/>{!storage.writable && <div className="aside-bottom mt-auto pt-6 text-[11px] text-muted-foreground"><div role="status">Storage unavailable</div><p className="break-words text-[10px] leading-relaxed">{storage.error}</p></div>}</div></aside>
      <main className={`flex min-w-0 flex-col bg-background ${inspectionExpanded ? 'floating-chat' : ''}`} style={inspectionExpanded ? {left: chatPosition.x, top: chatPosition.y} : undefined}>
        <div className="main-bar flex h-11 flex-none items-center justify-between gap-2 border-b px-4 text-xs" onPointerDown={event => {if (!inspectionExpanded || (event.target as HTMLElement).closest('button,input,textarea,select') || window.getSelection()?.toString()) return; drag.current={x:event.clientX,y:event.clientY,left:chatPosition.x,top:chatPosition.y};event.currentTarget.setPointerCapture(event.pointerId);}} onPointerMove={event => {if (drag.current) setChatPosition(clampChat({x:drag.current.left+event.clientX-drag.current.x,y:drag.current.top+event.clientY-drag.current.y}));}} onPointerUp={() => {drag.current=null;}} onPointerCancel={() => {drag.current=null;}}><div className="breadcrumb truncate">{activeFile ?? 'Chat'}</div>{activeFile && <Button variant="outline" size="sm" onClick={() => {setSelected(null);setEditing(false);}}>← Back to chat</Button>}</div>
        {error && <div className="error flex items-center gap-2 break-words border-b bg-destructive/10 px-4 py-2 text-xs text-destructive" role="alert">{error}<Button className="ml-auto" variant="ghost" size="icon-xs" aria-label="Dismiss error" onClick={() => setError('')}>×</Button></div>}
        {activeFile ? <section className="file-view flex min-h-0 flex-1 flex-col"><div className="file-toolbar flex items-center justify-between gap-3 border-b px-4 py-3 text-xs"><span className="truncate">{activeFile}</span><div className="flex gap-2">{editing ? <><Button variant="outline" size="sm" onClick={() => setEditing(false)}>Cancel</Button><Button size="sm" disabled={!storage.writable} onClick={() => attempt(() => {workspace.write(activeFile,sourceDraft);setEditing(false);})}>Save</Button></> : <Button variant="outline" size="sm" disabled={!storage.writable} onClick={() => {setSourceDraft(files[activeFile]);setEditing(true);}}>Edit file</Button>}<Button variant="destructive" size="sm" disabled={!storage.writable} onClick={() => setDeletePending(!deletePending)}>Delete</Button></div></div>{deletePending && <div className="delete-confirm flex items-center gap-2 break-words border-b bg-destructive/10 px-4 py-2 text-xs text-destructive">Delete {activeFile}?<Button variant="destructive" size="sm" disabled={!storage.writable} onClick={() => attempt(() => {workspace.remove(activeFile);setSelected(null);setDeletePending(false);})}>Confirm delete</Button><Button variant="outline" size="sm" onClick={() => setDeletePending(false)}>Cancel</Button></div>}{editing ? <Textarea className="code-editor min-h-0 flex-1 resize-none border-0 p-4 font-mono text-xs leading-6 shadow-none focus-visible:ring-0" disabled={!storage.writable} aria-label={`Edit ${activeFile}`} value={sourceDraft} onChange={e => setSourceDraft(e.target.value)} spellCheck={false}/> : <div className="source flex flex-1 items-start overflow-auto py-4"><div className="line-numbers select-none px-4 text-right font-mono text-xs leading-6 text-muted-foreground" aria-hidden="true">{files[activeFile].split('\n').map((_,i) => <div key={i}>{i+1}</div>)}</div><pre className="m-0 pr-6 font-mono text-xs leading-6" aria-label={`Contents of ${activeFile}`}>{files[activeFile]}</pre></div>}</section> : composer}
      </main>
      <section className="inspection" aria-label="Flow inspection">{showingFlow && <div className="inspection-toolbar"><button className="inspection-toggle" aria-label={inspectionExpanded ? 'Collapse inspection' : 'Expand inspection'} aria-expanded={inspectionExpanded} onClick={() => setInspectionExpanded(!inspectionExpanded)}><svg viewBox="0 0 24 24" aria-hidden="true">{inspectionExpanded ? <path d="M4 14h6v6m0-6-7 7M20 10h-6V4m0 6 7-7"/> : <path d="M15 3h6v6m0-6-7 7M9 21H3v-6m0 6 7-7"/>}</svg></button></div>}{view.inspectedFunction && <button className="back-definitions" onClick={() => updateView(v => ({...v,inspectedFunction:undefined}))}>← Definitions</button>}{visibleFlow ? <FlowView flow={visibleFlow} references={draft.references} expanded={view.expanded} onToggle={toggleExpansion} onSelect={selectNode} onOpenFunction={openFunction}/> : <div className="flow-notice">{analysis.kind === 'pending' ? 'Analyzing saved source…' : analysis.kind === 'failed' ? analysis.message : analysis.kind === 'invalid' ? analysis.diagnostics.map(d => d.message).join('\n') : 'Select a scope to inspect.'}</div>}</section>
    </div>
  </div>;
}
