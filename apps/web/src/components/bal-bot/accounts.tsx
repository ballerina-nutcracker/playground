import { useEffect, useRef, useState } from 'react';
import { loginProvider, logoutProvider, providerOptions, type ProviderAccount } from './providers';

interface Props {
  accounts: ProviderAccount[];
  provider: string;
  busy: boolean;
  chooseProvider: (provider: string) => void;
  refresh: () => Promise<void>;
  loginRequest: number;
}
function ProviderIcon({ id }: { id: string }) {
  return <span className="provider-icon" aria-hidden="true">{id === 'openai' || id === 'anthropic'
    ? <img src={`${import.meta.env.BASE_URL}${id}.svg`} alt="" width="20" height="20" />
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
  return <div className="provider-controls" ref={picker}>
    <div className="provider-picker">
      <button className="provider-trigger" aria-label={`Provider: ${selected.name}`} aria-expanded={pickerOpen} aria-controls="provider-options" disabled={busy || working} onClick={() => { setPickerOpen(!pickerOpen); setShowLogin(false); setKey(''); }}>
        <ProviderIcon id={provider} /><span>{selected.name}</span><span aria-hidden="true">⌄</span>
      </button>
      {pickerOpen && <div id="provider-options" className="provider-options" role="group" aria-label="Select provider">
        {providerOptions.map(option => <button key={option.id} className="provider-option" aria-pressed={provider === option.id} onClick={() => {
          chooseProvider(option.id); setPickerOpen(false); setError(''); setKey(''); setShowLogin(true);
        }}><ProviderIcon id={option.id} /><span>{option.name}<small>{option.description}</small></span>{accounts.find(account => account.id === option.id)?.connected && <span aria-label="API key configured">✓</span>}</button>)}
      </div>}
    </div>
    {showLogin && <section className="settings accounts provider-popover" aria-label="Provider API key">
      <div className="login-heading">{selected.name} API key</div>
      <p>Use an API key, not a subscription sign-in. Keys stay in this tab’s memory and are forgotten on refresh or close.</p>
      {current?.connected && <p role="status">API key configured. It will be checked when you send a message.</p>}
      <form className="api-key-form" onSubmit={event => { event.preventDefault(); void saveKey(); }}>
        <label>API key<input type="password" aria-label="API key" autoComplete="off" spellCheck={false} value={key} disabled={busy || working} onChange={event => setKey(event.target.value)} /></label>
        <button disabled={busy || working || !key.trim()}>{current?.connected ? 'Replace API key' : 'Use API key'}</button>
      </form>
      {error && <p className="message-error" role="alert">{error}</p>}
      {current?.connected && <div className="login-actions"><button disabled={busy || working} onClick={() => void forgetKey()}>Forget API key</button></div>}
    </section>}
  </div>;
}
