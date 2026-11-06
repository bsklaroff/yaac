// Public interface of the sealed feedback folder (`#domain/feedback`):
// forwarding a user's feedback to the maintainers' endpoint, signed as this
// install (docs/feedback.md).
//
// Each function added here needs a unit test in
// packages/server/test/domain/feedback/.

export { feedbackHost, rememberFeedbackUrl, submitFeedback } from './submit'
