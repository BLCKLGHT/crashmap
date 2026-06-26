type ErrorStateProps = {
  message: string;
  onRetry: () => void;
};

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div className="status-card status-card--error" role="alert">
      <strong>Crash data could not be loaded.</strong>
      <span>{message}</span>
      <button className="button button--primary" type="button" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
