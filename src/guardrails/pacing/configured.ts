import { PACING_DEFAULTS } from './defaults';
import { decidePacing, type PacingDecision, type PacingState } from './engine';

/**
 * The single configured decision used by every outbound path from Ahmed's one
 * WhatsApp number: customer replies, owner replies, and owner alerts.
 */
export function decideSharedPacing(
  now: Date,
  state: PacingState,
  rng?: () => number,
): PacingDecision {
  return decidePacing({
    now,
    knobs: PACING_DEFAULTS,
    state,
    crmDailyLimit: null,
    rng,
  });
}
