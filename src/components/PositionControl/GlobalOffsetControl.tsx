import type { OffsetDiagnosticFields } from '@/utils/offsetDiagnostics'
import type { OffsetUiOperation } from '@/utils/offsetUiDiagnostics'

import { useCallback, useEffect, useRef, useState } from 'react'

import { createOffsetUiDiagnostics } from '@/utils/offsetUiDiagnostics'
import { ncoState, useNcoState } from '@/hooks/useNco'

import { OffsetControl } from '@/components/OffsetControl'

export interface GlobalOffsetControlProps {
  compact?: boolean
}

export function GlobalOffsetControl({ compact }: GlobalOffsetControlProps) {
  const stateOffset = useNcoState('offset')

  const [currentOffset, setCurrentOffset] = useState(0)
  const [offset, setOffset] = useState(0)
  const [diagnostics] = useState(() =>
    createOffsetUiDiagnostics('GlobalOffsetControl')
  )
  const diagnosticSnapshot = useRef<OffsetDiagnosticFields>({
    stateOffset,
    offset,
    currentOffset,
    tabId: ncoState?.id ?? null,
  })
  const diagnosticApplySource = useRef<OffsetDiagnosticFields | null>(null)

  useEffect(() => {
    const ofs = stateOffset ?? 0

    diagnostics.log('ui.global-offset.state-sync', {
      ...diagnosticSnapshot.current,
      stateOffset,
      syncOffset: ofs,
    })
    setCurrentOffset(ofs)
    setOffset(ofs)
  }, [stateOffset])

  useEffect(() => {
    diagnosticSnapshot.current = {
      tabId: ncoState?.id ?? null,
      stateOffset,
      offset,
      currentOffset,
      compact: Boolean(compact),
    }
    diagnostics.log('ui.global-offset.snapshot', diagnosticSnapshot.current)
  }, [diagnostics, stateOffset, offset, currentOffset, compact])

  useEffect(() => {
    diagnostics.log('ui.mount', {
      ...diagnosticSnapshot.current,
      lifecycleObservation: 'effect-setup',
    })
    return () =>
      diagnostics.log('ui.unmount', {
        ...diagnosticSnapshot.current,
        lifecycleObservation: 'effect-cleanup',
      })
  }, [diagnostics])

  function onDiagnosticOperation(
    operation: OffsetUiOperation,
    fields: OffsetDiagnosticFields
  ) {
    if (operation === 'apply') diagnosticApplySource.current = fields
    diagnostics.log('ui.global-offset.operation', {
      ...diagnosticSnapshot.current,
      ...fields,
      operation,
    })
  }

  const onApply = useCallback(() => {
    const source = diagnosticApplySource.current
    diagnosticApplySource.current = null
    diagnostics.log('ui.global-offset.write', {
      ...diagnosticSnapshot.current,
      tabId: ncoState?.id ?? null,
      operation: 'apply',
      writer: 'GlobalOffsetControl.onApply',
      controlUiInstanceId: source?.controlUiInstanceId ?? null,
      uiOperationId: source?.uiOperationId ?? null,
      pressPointerType: source?.pressPointerType,
      applyOffset: offset,
      requestedOffsetSeconds: offset,
      stateWriteAvailable: Boolean(ncoState),
    })
    ncoState?.set('offset', offset)
  }, [offset])

  return (
    <div className="p-2">
      <OffsetControl
        compact={compact}
        value={offset}
        isValueChanged={offset !== currentOffset}
        onValueChange={setOffset}
        onApply={onApply}
        diagnosticContext={{
          globalUiInstanceId: diagnostics.uiInstanceId,
          tabId: ncoState?.id ?? null,
          stateOffset,
          currentOffset,
        }}
        onDiagnosticOperation={onDiagnosticOperation}
      />
    </div>
  )
}
