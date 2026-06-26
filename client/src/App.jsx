import React, { useEffect, useState } from 'react';
import { getMe, logout } from './api.js';
import { FLOWS } from './flows.js';
import Login from './components/Login.jsx';
import Home from './components/Home.jsx';
import Chat from './components/Chat.jsx';

export default function App() {
  const [state, setState] = useState({ loading: true, authenticated: false, user: null, loginStep: null });
  const [flowId, setFlowId] = useState(null); // null = home

  async function refresh() {
    const me = await getMe();
    setState({ loading: false, ...me });
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleLogout() {
    await logout();
    setFlowId(null);
    setState({ loading: false, authenticated: false, user: null, loginStep: null });
  }

  if (state.loading) {
    return <div className="app-loading">Loading…</div>;
  }

  const flow = flowId ? FLOWS[flowId] : null;

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-dot" />
          <span className="brand-name">Inventory Assistant</span>
          <span className="brand-sub">{flow ? flow.name : 'AI Agent Token Exchange'}</span>
        </div>
        {state.authenticated && (
          <div className="header-user">
            {flow && (
              <button className="btn-ghost" onClick={() => setFlowId(null)}>
                ← Home
              </button>
            )}
            <span>{state.user?.name || state.user?.email || state.user?.sub}</span>
            <button className="btn-ghost" onClick={handleLogout}>
              Sign out
            </button>
          </div>
        )}
      </header>

      {!state.authenticated && <Login />}
      {state.authenticated && !flow && <Home onSelect={setFlowId} />}
      {state.authenticated && flow && (
        <Chat key={flow.id} flow={flow} loginStep={state.loginStep} user={state.user} />
      )}
    </div>
  );
}
