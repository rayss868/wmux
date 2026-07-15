import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';
import { FOCUS_RING } from '../focusRing';

/**
 * GPUI / Zed-style button variants. The class recipes live in styles/ui.css
 * (theme-safe token color-mix). `icon` is a standalone square ghost chip; the
 * rest compose `.ui-btn` + a variant modifier.
 */
export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'danger'
  | 'dangerTinted'
  | 'icon';

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'ui-btn ui-btn-primary',
  secondary: 'ui-btn ui-btn-secondary',
  ghost: 'ui-btn ui-btn-ghost',
  danger: 'ui-btn ui-btn-danger',
  dangerTinted: 'ui-btn ui-btn-danger-tinted',
  icon: 'ui-icon-btn',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

/**
 * Shared button primitive. className-composable (caller classes append after
 * the variant recipe so sizing/layout overrides win) and ref-forwarding so it
 * drops into tight spots. The keyboard ring is the app-wide FOCUS_RING (single
 * ring system). `type` defaults to "button" so a Button inside a form never
 * submits by accident — pass `type="submit"` explicitly when that's wanted.
 */
const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', className = '', type, ...rest },
  ref,
) {
  const cls = `${VARIANT_CLASS[variant]} ${FOCUS_RING}${className ? ` ${className}` : ''}`;
  return <button ref={ref} type={type ?? 'button'} className={cls} {...rest} />;
});

export default Button;
