import { c as _c } from "react-compiler-runtime";
import { InterruptedByUser } from 'src/agent/ui/InterruptedByUser.js';
import { MessageResponse } from 'src/agent/ui/MessageResponse.js';
export function UserToolCanceledMessage() {
  const $ = _c(1);
  let t0;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t0 = <MessageResponse height={1}><InterruptedByUser /></MessageResponse>;
    $[0] = t0;
  } else {
    t0 = $[0];
  }
  return t0;
}
