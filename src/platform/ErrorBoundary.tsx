import * as React from 'react'
import { logError } from 'src/shared/log.js'

interface Props {
  children: React.ReactNode
  fallback?: React.ReactNode
  /**
   * Called after the error is logged, so the owner can unmount this boundary
   * — closing a dialog, say. There is no reset on the boundary itself: once
   * `hasError` is set it renders the fallback for as long as it stays mounted,
   * and the owner taking it down is what restores normal rendering.
   */
  onError?: (error: Error) => void
}

interface State {
  hasError: boolean
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  override componentDidCatch(error: Error): void {
    logError(error)
    this.props.onError?.(error)
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return this.props.fallback ?? null
    }
    return this.props.children
  }
}
