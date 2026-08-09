import { Component, type ErrorInfo, type ReactNode } from 'react'
import { recordStructureFailure } from './structureDiagnostics'

interface StructureAssetBoundaryProps {
  assetId: string
  fallback: ReactNode
  children: ReactNode
}

interface StructureAssetBoundaryState {
  failed: boolean
}

export default class StructureAssetBoundary extends Component<
  StructureAssetBoundaryProps,
  StructureAssetBoundaryState
> {
  state: StructureAssetBoundaryState = { failed: false }

  static getDerivedStateFromError(): StructureAssetBoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    recordStructureFailure(this.props.assetId, error.message)
    if (import.meta.env.DEV) {
      console.warn(`Aetheris structure fallback activated for ${this.props.assetId}.`, error, info)
    }
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
