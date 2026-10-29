export function Mark() {
  return (
    <svg className="mark" viewBox="0 0 24 24" aria-hidden="true">
      <path className="wa" d="M3.6 12a8.4 8.4 0 0 1 15.9-3.8" />
      <path className="wa" d="M20.2 4.6v3.9h-3.9" />
      <path className="wb" d="M20.4 12a8.4 8.4 0 0 1-15.9 3.8" />
      <path className="wb" d="M3.8 19.4v-3.9h3.9" />
    </svg>
  );
}

export function Branch() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="7" cy="6" r="2.2" />
      <circle cx="7" cy="18" r="2.2" />
      <circle cx="17" cy="8" r="2.2" />
      <path d="M7 8.2v7.6M17 10.2c0 3.6-3.4 4.6-8 5.6" />
    </svg>
  );
}

export function CompareIcon() {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="4.5" width="18" height="15" rx="3" />
      <path d="M12 4.5v15" />
    </svg>
  );
}

export function PromptIcon() {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 4l5.6 15 2.2-6.4L19.2 10z" />
      <path d="M14 14l5 5" />
    </svg>
  );
}

export function KeepIcon() {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 15V4" />
      <path d="M7.5 8.5L12 4l4.5 4.5" />
      <path d="M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true" style={{ width: 14, height: 14 }}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
