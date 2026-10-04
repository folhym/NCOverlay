import type { OffsetDiagnosticFields } from '@/utils/offsetDiagnostics'
import type { OffsetUiOperation } from '@/utils/offsetUiDiagnostics'

import { useEffect, useRef, useState } from 'react'
import { Button, ButtonGroup, Divider, Input, cn } from '@heroui/react'
import { CheckIcon, RotateCcwIcon } from 'lucide-react'

import { createOffsetUiDiagnostics } from '@/utils/offsetUiDiagnostics'

export interface OffsetControlProps {
  value: number
  isValueChanged?: boolean
  compact?: boolean
  onValueChange: (value: number) => void
  onApply: () => void
  diagnosticContext?: OffsetDiagnosticFields
  onDiagnosticOperation?: (
    operation: OffsetUiOperation,
    fields: OffsetDiagnosticFields
  ) => void
}

export function OffsetControl({
  value,
  onValueChange,
  onApply,
  isValueChanged,
  compact,
  diagnosticContext,
  onDiagnosticOperation,
}: OffsetControlProps) {
  const [diagnostics] = useState(() =>
    diagnosticContext ? createOffsetUiDiagnostics('OffsetControl') : null
  )
  const diagnosticSequence = useRef(0)
  const diagnosticSnapshot = useRef<OffsetDiagnosticFields>({})

  useEffect(() => {
    diagnosticSnapshot.current = {
      ...diagnosticContext,
      offset: value,
      compact: Boolean(compact),
      applyDisabled: isValueChanged === false,
    }
  }, [diagnosticContext, value, compact, isValueChanged])

  useEffect(() => {
    diagnostics?.log('ui.mount', {
      ...diagnosticSnapshot.current,
      lifecycleObservation: 'effect-setup',
    })
    return () =>
      diagnostics?.log('ui.unmount', {
        ...diagnosticSnapshot.current,
        lifecycleObservation: 'effect-cleanup',
      })
  }, [diagnostics])

  function logOperation(
    operation: OffsetUiOperation,
    fields: OffsetDiagnosticFields = {}
  ) {
    if (!diagnostics) return
    const details = {
      ...diagnosticContext,
      offset: value,
      operation,
      controlUiInstanceId: diagnostics.uiInstanceId,
      uiOperationId: `${diagnostics.uiInstanceId}-${++diagnosticSequence.current}`,
      applyDisabled: isValueChanged === false,
      ...fields,
    }
    diagnostics.log('ui.offset-control.operation', details)
    onDiagnosticOperation?.(operation, details)
  }

  function onValueChangeInput(val: string) {
    const nextOffset = Number(val)
    logOperation('input', { nextOffset })
    onValueChange(nextOffset)
  }

  function onPressReset() {
    logOperation('reset', { nextOffset: 0, writesState: false })
    onValueChange(0)
  }

  function onPressStep(sec: number) {
    logOperation('±button', { deltaSeconds: sec, nextOffset: value + sec })
    onValueChange(value + sec)
  }

  return (
    <div className={cn('flex h-fit gap-2', compact ? 'flex-row' : 'flex-col')}>
      <div className="flex flex-row gap-1.5">
        <ButtonGroup size="sm" variant="flat">
          {[-30, -10, -1].map((sec) => (
            <Button
              key={sec}
              className={cn(
                'min-w-8 px-2',
                'border-divider not-first:border-l-1'
              )}
              onPress={() => onPressStep(sec)}
            >
              {sec}
            </Button>
          ))}
        </ButtonGroup>

        <Input
          classNames={{
            inputWrapper: 'border-1 border-divider shadow-none',
            input: [
              'text-right',
              '[appearance:textfield]',
              '[&::-webkit-inner-spin-button]:appearance-none',
              '[&::-webkit-outer-spin-button]:appearance-none',
            ],
          }}
          type="number"
          size="sm"
          placeholder="0"
          endContent="秒"
          value={value.toString()}
          onValueChange={onValueChangeInput}
        />

        <ButtonGroup size="sm" variant="flat">
          {[1, 10, 30].map((sec) => (
            <Button
              key={sec}
              className={cn(
                'min-w-8 px-2',
                'border-divider not-first:border-l-1'
              )}
              onPress={() => onPressStep(sec)}
            >
              +{sec}
            </Button>
          ))}
        </ButtonGroup>
      </div>

      {compact && <Divider className="h-8" orientation="vertical" />}

      <div className={cn('flex flex-row gap-2', !compact && 'justify-between')}>
        <Button
          size="sm"
          variant="flat"
          fullWidth
          isIconOnly={compact}
          isDisabled={value === 0}
          startContent={<RotateCcwIcon className="size-4" />}
          onPress={onPressReset}
        >
          {!compact && <span>リセット</span>}
        </Button>

        <Button
          size="sm"
          variant="solid"
          color="primary"
          fullWidth
          isIconOnly={compact}
          isDisabled={isValueChanged === false}
          startContent={<CheckIcon className="size-4" />}
          onPress={(event) => {
            logOperation('apply', {
              applyOffset: value,
              pressPointerType: event?.pointerType,
            })
            onApply()
          }}
        >
          {!compact && <span>適用</span>}
        </Button>
      </div>
    </div>
  )
}
