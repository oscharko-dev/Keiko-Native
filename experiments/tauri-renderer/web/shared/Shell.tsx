import type { ChangeEventHandler } from "react";

type Props = {
  inputValue: string;
  onInput?: ChangeEventHandler<HTMLInputElement>;
  onNativeCancel?: () => void;
  status: string;
};

export function Shell({ inputValue, onInput, onNativeCancel, status }: Props) {
  return (
    <main aria-labelledby="shell-title">
      <h1 id="shell-title">Keiko Foundation</h1>
      <p>Tauri system WebView candidate</p>
      <label htmlFor="synthetic-input">Synthetic international input</label>
      <input
        id="synthetic-input"
        autoComplete="off"
        defaultValue={inputValue}
        onChange={onInput}
      />
      <div className="actions" role="group" aria-label="Foundation diagnostics">
        <button type="button">Focus checkpoint</button>
        <button type="button" onClick={onNativeCancel}>
          Native cancellation
        </button>
      </div>
      <p id="status" role="status" aria-live="polite">
        {status}
      </p>
    </main>
  );
}
