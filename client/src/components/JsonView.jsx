import React from 'react';

export default function JsonView({ value }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (
    <pre className="jsonview">
      <code>{text}</code>
    </pre>
  );
}
