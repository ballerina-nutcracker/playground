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

function messageText(message: AgentMessage): string {
  const text = typeof message.content === 'string' ? message.content : message.content.map(part => part.type === 'text' ? part.text : '').filter(Boolean).join('\n');
  if (message.role !== 'user' || !text.includes('<workspace-scope>')) return text;
  const prose = text.split('<workspace-scope>')[0].trimEnd();
  try { const entries = JSON.parse(text.split('<source-references>\n')[1].split('\n</source-references>')[0]) as {label: string}[]; return [prose, ...entries.map(e => e.label)].filter(Boolean).join('\n'); } catch { return text; }
}
function EndpointLabel({endpoint}: {endpoint: Endpoint}): React.JSX.Element {
  const separator = endpoint.kind === 'resource' ? endpoint.title.indexOf(' ') : -1;
  return <><small>{endpoint.kind}</small><span className="endpoint-label">{separator > 0 ? <><span className="endpoint-operation">{endpoint.title.slice(0, separator)}</span>{' '}{endpoint.title.slice(separator + 1)}</> : endpoint.title}</span></>;
}
interface AnchorView { readonly draft: ChatDraft; readonly expanded: ReadonlySet<ExpansionPath>; readonly inspectedFunction?: Id; }
const emptyView: AnchorView = {draft: {text: '', references: []}, expanded: new Set()};
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
  const composer = <><div className="conversation" ref={element => {if (element) element.scrollTop = element.scrollHeight;}}>{!conversation.length && <div className="welcome"><h1>What shall we build?</h1><p>Describe a change or attach source from the flow.</p></div>}{conversation.map((item,i) => item.kind === 'tool' ? <div key={`tool-${item.id}`} className={`tool-summary tool-${item.state}`}>{item.text}</div> : <article key={i} className={`message ${item.message.role}`}><div className="message-label">{item.message.role === 'user' ? 'You' : 'bal-bot'}</div><div className="message-body">{item.message.role === 'assistant' ? <Markdown remarkPlugins={[remarkGfm]}>{messageText(item.message)}</Markdown> : <pre>{messageText(item.message)}</pre>}</div>{item.message.role === 'assistant' && item.message.errorMessage && <p className="message-error">{item.message.errorMessage}</p>}</article>)}</div><div className="composer-area">{(busy || compactionState === 'compacting') && <div className="activity" role="status">{compactionState === 'compacting' ? 'Compacting conversation…' : 'working...'}</div>}<form className="composer" onSubmit={event => {event.preventDefault(); void send();}}><ReferenceChips draft={draft} onRemove={id => updateView(v => ({...v, draft: removeReference(v.draft, id)}))}/><textarea aria-label="Message" disabled={compactionState === 'failed'} placeholder="Describe a change…" value={draft.text} onChange={e => updateView(v => ({...v, draft: {...v.draft, text: e.target.value}}))} onKeyDown={e => {if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {e.preventDefault(); void send();}}}/><div className="composer-bottom"><label className="composer-model"><span className="sr-only">Model</span><select aria-label="Model" value={activeModel?.id ?? ''} disabled={busy || !providerModels.length} onChange={e => setModel(e.target.value)}>{!providerModels.length && <option value="">Loading models…</option>}{providerModels.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>{busy ? <button type="button" onClick={() => agent.current?.abort()}>Stop ■</button> : <button className="send" aria-label="Send message" disabled={compactionState === 'failed' || (!draft.text.trim() && !draft.references.length) || !storage.writable || draft.references.some(r => r.stale)}>↑</button>}</div></form></div></>;
  return <div className="app"><header><div className="brand"><img src={`${import.meta.env.BASE_URL}ballerina.ico`} alt="Ballerina logo" width="36" height="36"/>bal-bot</div><Accounts accounts={accounts} provider={provider} busy={busy} chooseProvider={id => {setProvider(id);setModel('');}} refresh={refreshAccounts} loginRequest={loginRequest}/></header>
    <div ref={workspaceElement} className={`workspace flow-workspace ${inspectionExpanded ? 'inspection-expanded' : ''}`}>
      <aside id="workspace-sidebar" className={sidebarCollapsed ? 'collapsed' : ''}><div className="sidebar-heading"><span>WORKSPACE</span><button aria-label={sidebarCollapsed ? 'Expand workspace sidebar' : 'Collapse workspace sidebar'} onClick={() => setSidebarCollapsed(!sidebarCollapsed)}>☰</button></div><div hidden={sidebarCollapsed} className="sidebar-content"><div className="project">{projectName}</div>{scopes.map(scope => <React.Fragment key={scope.id}><AnchorButton anchor={scope} className={`service ${anchorId === scope.id ? 'selected' : ''}`} data-scope-id={scope.id} onChoose={() => chooseAnchor(scope.id)}>{scope.title}{scope.scopeKind === 'service' && <small>{scope.kind ?? 'Service'}</small>}{scope.scopeKind === 'automation' && scopes.length > 1 && <small>{scope.id.split('/function/')[0]}</small>}</AnchorButton>{scope.scopeKind === 'service' && scope.getEndpoints().map(endpoint => <AnchorButton key={endpoint.id} anchor={endpoint} className={`endpoint ${anchorId === endpoint.id ? 'selected' : ''}`} onChoose={() => chooseAnchor(endpoint.id)}><EndpointLabel endpoint={endpoint}/></AnchorButton>)}</React.Fragment>)}<div className="section-title file-heading">FILES<button disabled={!storage.writable} aria-label="New file" onClick={() => setCreating(!creating)}>+</button></div>{creating && <form className="new-file" onSubmit={event => {event.preventDefault();attempt(() => {if (Object.hasOwn(files,newPath)) throw new Error('File already exists');workspace.write(newPath,'');openFile(newPath);setNewPath('');setCreating(false);});}}><input aria-label="New file path" disabled={!storage.writable} value={newPath} onChange={e => setNewPath(e.target.value)} autoFocus/><button disabled={!storage.writable}>Add</button></form>}<FileTree paths={workspace.list()} selected={selected} open={openFile}/>{!storage.writable && <div className="aside-bottom"><div role="status">Storage unavailable</div><p>{storage.error}</p></div>}</div></aside>
      <main className={inspectionExpanded ? 'floating-chat' : ''} style={inspectionExpanded ? {left: chatPosition.x, top: chatPosition.y} : undefined}>
        <div className="main-bar" onPointerDown={event => {if (!inspectionExpanded || (event.target as HTMLElement).closest('button,input,textarea,select') || window.getSelection()?.toString()) return; drag.current={x:event.clientX,y:event.clientY,left:chatPosition.x,top:chatPosition.y};event.currentTarget.setPointerCapture(event.pointerId);}} onPointerMove={event => {if (drag.current) setChatPosition(clampChat({x:drag.current.left+event.clientX-drag.current.x,y:drag.current.top+event.clientY-drag.current.y}));}} onPointerUp={() => {drag.current=null;}} onPointerCancel={() => {drag.current=null;}}><div className="breadcrumb">{activeFile ?? 'Chat'}</div>{activeFile && <button onClick={() => {setSelected(null);setEditing(false);}}>← Back to chat</button>}</div>
        {error && <div className="error" role="alert">{error}<button aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
        {activeFile ? <section className="file-view"><div className="file-toolbar"><span>{activeFile}</span><div>{editing ? <><button onClick={() => setEditing(false)}>Cancel</button><button disabled={!storage.writable} className="primary" onClick={() => attempt(() => {workspace.write(activeFile,sourceDraft);setEditing(false);})}>Save</button></> : <button disabled={!storage.writable} onClick={() => {setSourceDraft(files[activeFile]);setEditing(true);}}>Edit file</button>}<button disabled={!storage.writable} onClick={() => setDeletePending(!deletePending)}>Delete</button></div></div>{deletePending && <div className="delete-confirm">Delete {activeFile}?<button disabled={!storage.writable} onClick={() => attempt(() => {workspace.remove(activeFile);setSelected(null);setDeletePending(false);})}>Confirm delete</button><button onClick={() => setDeletePending(false)}>Cancel</button></div>}{editing ? <textarea className="code-editor" disabled={!storage.writable} aria-label={`Edit ${activeFile}`} value={sourceDraft} onChange={e => setSourceDraft(e.target.value)} spellCheck={false}/> : <div className="source"><div className="line-numbers" aria-hidden="true">{files[activeFile].split('\n').map((_,i) => <div key={i}>{i+1}</div>)}</div><pre aria-label={`Contents of ${activeFile}`}>{files[activeFile]}</pre></div>}</section> : composer}
      </main>
      <section className="inspection" aria-label="Flow inspection">{showingFlow && <div className="inspection-toolbar"><button className="inspection-toggle" aria-label={inspectionExpanded ? 'Collapse inspection' : 'Expand inspection'} aria-expanded={inspectionExpanded} onClick={() => setInspectionExpanded(!inspectionExpanded)}><svg viewBox="0 0 24 24" aria-hidden="true">{inspectionExpanded ? <path d="M4 14h6v6m0-6-7 7M20 10h-6V4m0 6 7-7"/> : <path d="M15 3h6v6m0-6-7 7M9 21H3v-6m0 6 7-7"/>}</svg></button></div>}{view.inspectedFunction && <button className="back-definitions" onClick={() => updateView(v => ({...v,inspectedFunction:undefined}))}>← Definitions</button>}{visibleFlow ? <FlowView flow={visibleFlow} references={draft.references} expanded={view.expanded} onToggle={toggleExpansion} onSelect={selectNode} onOpenFunction={openFunction}/> : <div className="flow-notice">{analysis.kind === 'pending' ? 'Analyzing saved source…' : analysis.kind === 'failed' ? analysis.message : analysis.kind === 'invalid' ? analysis.diagnostics.map(d => d.message).join('\n') : 'Select a scope to inspect.'}</div>}</section>
    </div>
  </div>;
}
