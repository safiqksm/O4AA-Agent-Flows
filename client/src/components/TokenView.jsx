import React from 'react';
import JsonView from './JsonView.jsx';
import CodeBlock from './CodeBlock.jsx';

export default function TokenView({ token }) {
  if (!token) {
    return <div className="tab-empty">No JWT to decode for this step.</div>;
  }
  if (token.opaque) {
    return (
      <div className="tokenview">
        <div className="tokenview-note">This is an opaque token (not a JWT) — showing the raw value.</div>
        <CodeBlock text={token.raw} label="RAW TOKEN" />
      </div>
    );
  }
  return (
    <div className="tokenview">
      <div className="token-section">
        <h4>HEADER</h4>
        <JsonView value={token.header} />
      </div>
      <div className="token-section">
        <h4>PAYLOAD</h4>
        <JsonView value={token.payload} />
      </div>
      <div className="token-section">
        <h4>RAW</h4>
        <CodeBlock text={token.raw} label="JWT" />
      </div>
    </div>
  );
}
