type LoadingStateProps = {
  message: string;
};

export function LoadingState({ message }: LoadingStateProps) {
  return (
    <div className="status-card status-card--loading" role="status" aria-live="polite">
      <span className="loader" aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}
