import React from 'react';

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, errorInfo);
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      // 테마 토큰 클래스만 쓴다(raw hex·인라인 스타일 금지, DESIGN_SYSTEM §12.12-7).
      return (
        <div role="alert" className="min-h-screen bg-background text-foreground flex items-center justify-center p-4">
          <div className="w-full max-w-xl p-6">
            <h1 className="text-lg font-semibold text-status-critical mb-2">
              화면을 표시하는 중 오류가 발생했습니다
            </h1>
            <p className="text-sm text-muted-foreground mb-4">
              다시 시도하거나 페이지를 새로고침하세요. 문제가 계속되면 아래 오류 내용을 관리자에게 전달하세요.
            </p>
            <pre className="bg-secondary border border-border rounded-md p-4 text-xs font-mono text-foreground overflow-auto max-h-80 whitespace-pre-wrap break-words">
              {this.state.error?.message}
              {'\n\n'}
              {this.state.error?.stack}
            </pre>
            <div className="mt-4 flex items-center gap-2">
              <button
                type="button"
                onClick={this.handleRetry}
                className="px-4 py-2 text-sm font-medium rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                다시 시도
              </button>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="px-4 py-2 text-sm font-medium rounded-xl border border-border bg-card text-foreground hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                새로고침
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
