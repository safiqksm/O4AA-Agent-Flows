import React, { useEffect, useState } from 'react';
import StepCard from './StepCard.jsx';

// The stepper sub-label is the step's own title (stripped of any "· detail" suffix),
// so it adapts across flows (id-JAG / vaulted secret / service account / MCP).
const sublabel = (step) => (step.title || '').split('·')[0].trim();

export default function SequenceView({ steps }) {
  const [active, setActive] = useState(steps[0]?.id);

  useEffect(() => {
    if (steps.length && !steps.find((s) => s.id === active)) {
      setActive(steps[0].id);
    }
  }, [steps]);

  if (!steps.length) {
    return (
      <div className="sequence-empty">
        <h2>API Call Sequence</h2>
        <p>Ask a question to watch the Cross-App Access token chain execute step by step.</p>
      </div>
    );
  }

  return (
    <div className="sequence">
      <div className="stepper">
        {steps.map((s) => (
          <button
            key={s.id}
            className={`step-tab ${active === s.id ? 'active' : ''} ${s.ok ? 'ok' : 'fail'}`}
            onClick={() => setActive(s.id)}
          >
            <span className="step-dot" />
            <span className="step-tab-main">
              <strong>{s.id}</strong> — {s.badge}
            </span>
            <span className="step-tab-sub">{sublabel(s)}</span>
          </button>
        ))}
      </div>

      <div className="cards">
        {steps.map((s) => (
          <StepCard key={s.id} step={s} expanded={active === s.id} onSelect={() => setActive(s.id)} />
        ))}
      </div>
    </div>
  );
}
