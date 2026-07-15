import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

/**
 * Recessed text input (GPUI sunken field; recipe in styles/ui.css). Focus
 * paints the cool --accent-blue border + glow (navigation/interactive
 * grammar). className-composable and ref-forwarding. Font size / weight are
 * left to the caller (or inherited) so it fits both dialog and compact chrome.
 */
const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className = '', ...rest },
  ref,
) {
  return (
    <input ref={ref} className={`ui-input${className ? ` ${className}` : ''}`} {...rest} />
  );
});

export default Input;
