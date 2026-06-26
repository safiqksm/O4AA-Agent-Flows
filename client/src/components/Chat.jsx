import React, { useState } from 'react';
import { ask, revokeSts } from '../api.js';
import SequenceView from './SequenceView.jsx';

export default function Chat({ loginStep, flow }) {
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      text: `Hi! ${
        flow.id === 'sts-github'
          ? 'Click “Read pull requests” or “Create a pull request” to start.'
          : 'Ask me about inventory or recent shipments.'
      } I’ll run it through the ${flow.name} flow.`,
    },
  ]);
  const [input, setInput] = useState('');
  // Flows that act on the user's behalf show the login as T1; the service-app flow does not.
  const baseSteps = flow.prependLogin !== false && loginStep ? [loginStep] : [];
  const [steps, setSteps] = useState(baseSteps);
  const [busy, setBusy] = useState(false);
  const [interaction, setInteraction] = useState(null); // { uri } when consent is required
  const [lastQuestion, setLastQuestion] = useState(null);

  const suggestions = flow.suggestions || [];

  async function submit(text) {
    const question = (text ?? input).trim();
    if (!question || busy) return;
    setInput('');
    setInteraction(null);
    setLastQuestion(question);
    setMessages((m) => [...m, { role: 'user', text: question }]);
    setBusy(true);
    try {
      const res = await ask(question, flow.id);
      setMessages((m) => [...m, { role: 'assistant', text: res.answer }]);
      setSteps([...baseSteps, ...(res.steps || [])]);
      if (res.interaction?.uri) setInteraction(res.interaction);
    } catch (err) {
      setMessages((m) => [...m, { role: 'assistant', text: `Something went wrong: ${err.message}` }]);
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (busy) return;
    setInteraction(null);
    setBusy(true);
    try {
      const res = await revokeSts();
      setMessages((m) => [...m, { role: 'assistant', text: res.answer }]);
      if (res.steps?.length) setSteps((prev) => [...prev, ...res.steps]);
    } catch (err) {
      setMessages((m) => [...m, { role: 'assistant', text: `Revoke failed: ${err.message}` }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="workspace">
      <section className="chat-pane">
        <div className="messages">
          {messages.map((m, i) => (
            <div key={i} className={`msg msg-${m.role}`}>
              <div className="msg-bubble">{m.text}</div>
            </div>
          ))}
          {interaction && (
            <div className="msg msg-assistant">
              <div className="msg-bubble consent">
                <p>Consent is required for this connection.</p>
                <div className="consent-actions">
                  <a className="btn-primary" href={interaction.uri} target="_blank" rel="noreferrer">
                    Authorize connection ↗
                  </a>
                  <button className="btn-ghost dark" disabled={busy} onClick={() => submit(lastQuestion)}>
                    Retry
                  </button>
                </div>
              </div>
            </div>
          )}
          {busy && (
            <div className="msg msg-assistant">
              <div className="msg-bubble msg-thinking">Running the access chain…</div>
            </div>
          )}
        </div>

        <div className="suggestions">
          {suggestions.map((s) => (
            <button key={s.label} className="chip" disabled={busy} onClick={() => submit(s.text)}>
              {s.label}
            </button>
          ))}
        </div>

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={flow.id === 'sts-github' ? 'Ask the agent to read pull requests…' : 'Ask about inventory or shipments…'}
            disabled={busy}
          />
          <button className="btn-primary" type="submit" disabled={busy}>
            Send
          </button>
        </form>

        {flow.id === 'sts-github' && (
          <div className="revoke-bar">
            <button className="btn-revoke" disabled={busy} onClick={revoke}>
              Revoke STS token (re-trigger consent)
            </button>
          </div>
        )}
      </section>

      <section className="sequence-pane">
        <SequenceView steps={steps} />
      </section>
    </div>
  );
}
