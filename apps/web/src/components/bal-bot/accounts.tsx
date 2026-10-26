import { useEffect, useRef, useState } from 'react';
import { loginProvider, logoutProvider, providerOptions, type ProviderAccount } from './providers';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface Props {
  accounts: ProviderAccount[];
  provider: string;
  busy: boolean;
  chooseProvider: (provider: string) => void;
  refresh: () => Promise<void>;
  loginRequest: number;
}
function ProviderIcon({ id }: { id: string }) {
  return <span className="provider-icon inline-flex size-5 flex-none items-center justify-center" aria-hidden="true">{id === 'openai' || id === 'anthropic'
    ? <img src={`${import.meta.env.BASE_URL}${id}.svg`} alt="" width="20" height="20" className="size-5 object-contain" />
    : <span>{id === 'google' ? '✦' : '⇄'}</span>}</span>;
}
export function Accounts({ accounts, provider, busy, chooseProvider, refresh, loginRequest }: Props) {
  const [error, setError] = useState('');
  const [key, setKey] = useState('');
  const [working, setWorking] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const picker = useRef<HTMLDivElement>(null);
  const lastLoginRequest = useRef(loginRequest);
  const selected = providerOptions.find(option => option.id === provider)!;
  const current = accounts.find(account => account.id === provider);
  useEffect(() => {
    if (!pickerOpen && !showLogin) return;
    const dismiss = (event: MouseEvent) => {
      if (!picker.current?.contains(event.target as Node)) { setPickerOpen(false); setShowLogin(false); setKey(''); }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setPickerOpen(false); setShowLogin(false); setKey(''); }
    };
    document.addEventListener('mousedown', dismiss); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', dismiss); document.removeEventListener('keydown', escape); };
  }, [pickerOpen, showLogin]);
  useEffect(() => {
    if (lastLoginRequest.current === loginRequest) return;
    lastLoginRequest.current = loginRequest;
    setError(''); setKey(''); setShowLogin(true);
  }, [loginRequest]);
  async function saveKey() {
    setWorking(true); setError('');
    try { await loginProvider(provider, key); setKey(''); await refresh(); setShowLogin(false); }
    catch { setKey(''); setError('Could not configure the API key. Please try again.'); }
    finally { setWorking(false); }
  }
  async function forgetKey() {
    setWorking(true); setError(''); setKey('');
    try { await logoutProvider(provider); await refresh(); setShowLogin(false); }
    catch { setError('Could not forget the API key. Please retry.'); }
    finally { setWorking(false); }
  }
  return <div className="provider-controls flex min-w-0 items-center gap-2" ref={picker}>
    <div className="provider-picker relative">
      <Button variant="outline" size="sm" className="provider-trigger" aria-label={`Provider: ${selected.name}`} aria-expanded={pickerOpen} aria-controls="provider-options" disabled={busy || working} onClick={() => { setPickerOpen(!pickerOpen); setShowLogin(false); setKey(''); }}>
        <ProviderIcon id={provider} /><span>{selected.name}</span><span aria-hidden="true">⌄</span>
      </Button>
      {pickerOpen && <div id="provider-options" className="provider-options absolute right-0 top-full z-20 mt-1 flex w-72 flex-col border bg-popover p-1 text-popover-foreground shadow-md" role="group" aria-label="Select provider">
        {providerOptions.map(option => <Button key={option.id} variant="ghost" className="provider-option h-auto w-full justify-start gap-2 py-2 text-left" aria-pressed={provider === option.id} onClick={() => {
          chooseProvider(option.id); setPickerOpen(false); setError(''); setKey(''); setShowLogin(true);
        }}><ProviderIcon id={option.id} /><span className="min-w-0 flex-1 text-left">{option.name}<small className="block text-[10px] font-normal text-muted-foreground">{option.description}</small></span>{accounts.find(account => account.id === option.id)?.connected && <span aria-label="API key configured">✓</span>}</Button>)}
      </div>}
    </div>
    {showLogin && <section className="settings accounts provider-popover absolute right-3 top-12 z-20 flex w-[min(460px,calc(100vw-2rem))] flex-col gap-3 border bg-popover p-4 text-popover-foreground shadow-md" aria-label="Provider API key">
      <div className="login-heading text-sm font-semibold">{selected.name} API key</div>
      <p className="text-[11px] text-muted-foreground">Use an API key, not a subscription sign-in. Keys stay in this tab’s memory and are forgotten on refresh or close.</p>
      {current?.connected && <p className="text-[11px] text-muted-foreground" role="status">API key configured. It will be checked when you send a message.</p>}
      <form className="api-key-form flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void saveKey(); }}>
        <label className="flex flex-col gap-1.5 text-[11px]">API key<Input className="h-8" type="password" aria-label="API key" autoComplete="off" spellCheck={false} value={key} disabled={busy || working} onChange={event => setKey(event.target.value)} /></label>
        <Button type="submit" className="self-end" disabled={busy || working || !key.trim()}>{current?.connected ? 'Replace API key' : 'Use API key'}</Button>
      </form>
      {error && <p className="message-error text-xs text-destructive" role="alert">{error}</p>}
      {current?.connected && <div className="login-actions"><Button variant="outline" size="sm" disabled={busy || working} onClick={() => void forgetKey()}>Forget API key</Button></div>}
    </section>}
  </div>;
}
