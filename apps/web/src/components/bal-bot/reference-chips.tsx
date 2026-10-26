import React from 'react';
import { formatReference, type ChatDraft } from './references';
import type { Id } from '@bal-bot/workspace';
export interface ReferenceChipsProps { readonly draft: ChatDraft; readonly onRemove: (id: Id) => void; }
export function ReferenceChips({draft, onRemove}: ReferenceChipsProps): React.JSX.Element {
  return <div className="reference-chips">{draft.references.map(chip => <span key={chip.id} className={`reference-chip ${chip.stale ? 'stale' : ''}`} title={chip.stale ? 'Source changed. Remove or reselect this reference.' : chip.text}>{formatReference(chip.source)}{chip.stale && ' · stale'}<button type="button" aria-label={`Remove ${formatReference(chip.source)}`} onClick={() => onRemove(chip.id)}>×</button></span>)}</div>;
}
