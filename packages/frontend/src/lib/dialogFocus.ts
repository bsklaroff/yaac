/**
 * Whether focus is inside an open dialog or popover. A pane that takes focus
 * on its own when it appears or is selected (a workspace finishing its
 * start-up, say) checks this first, so it never pulls the user's keystrokes
 * out of the dialog they are typing into.
 */
export function dialogHoldsFocus(): boolean {
  return document.activeElement?.closest('[role="dialog"], [role="alertdialog"]') != null
}
