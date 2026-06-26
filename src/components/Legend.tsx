export function Legend() {
  return (
    <section className="legend" aria-label="Map legend">
      <div className="legend__row">
        <span className="legend__heat" />
        <span>Hotter areas show more historical crashes.</span>
      </div>
      <div className="legend__row">
        <span className="legend__dot legend__dot--fatal" />
        <span>Fatal</span>
      </div>
      <div className="legend__row">
        <span className="legend__dot legend__dot--serious" />
        <span>Serious</span>
      </div>
      <div className="legend__row">
        <span className="legend__dot legend__dot--other" />
        <span>Other recorded crashes</span>
      </div>
    </section>
  );
}
