import React from 'react';
import { FLOW_LIST } from '../flows.js';

export default function Home({ onSelect }) {
  return (
    <div className="home">
      <div className="home-head">
        <h1>Choose a token-exchange flow</h1>
        <p>Each use case logs in once (T1), then walks the agent’s token exchange step by step.</p>
      </div>
      <div className="home-grid">
        {FLOW_LIST.map((f) => (
          <button key={f.id} className="flow-card" style={{ '--accent': f.accent }} onClick={() => onSelect(f.id)}>
            <span className="flow-accent" />
            <h2>{f.name}</h2>
            <div className="flow-tagline">{f.tagline}</div>
            <p>{f.description}</p>
            <span className="flow-go">Open →</span>
          </button>
        ))}
      </div>
    </div>
  );
}
