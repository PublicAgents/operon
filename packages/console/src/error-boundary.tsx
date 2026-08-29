import { Component, type ReactNode } from "react";

/**
 * A crashed page must never blank the console: React unmounts the whole
 * tree on an uncaught render error, which reads as "the UI disappeared".
 * This shows the error where the page was and leaves the navigation
 * usable. The key remounts the boundary on route change, so one broken
 * page never poisons the next.
 */
export class PageBoundary extends Component<
  { children: ReactNode },
  { error?: string }
> {
  override state: { error?: string } = {};

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }

  override render() {
    if (this.state.error !== undefined) {
      return (
        <section>
          <header className="page-head">
            <h1>This page crashed</h1>
          </header>
          <div className="error-note">{this.state.error}</div>
          <button onClick={() => this.setState({ error: undefined })}>retry</button>
        </section>
      );
    }
    return this.props.children;
  }
}
