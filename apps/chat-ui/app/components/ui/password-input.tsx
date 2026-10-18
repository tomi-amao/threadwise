import * as React from 'react';
import { Eye, EyeSlash } from 'phosphor-react';
import { Input, type InputProps } from './input';

/** A password field with a show/hide switch. Takes the same props as Input (so Field can label it). */
export const PasswordInput = React.forwardRef<HTMLInputElement, Omit<InputProps, 'type'>>(
  ({ className, ...props }, ref) => {
    const [shown, setShown] = React.useState(false);
    return (
      <div className="relative">
        <Input
          ref={ref}
          type={shown ? 'text' : 'password'}
          className={`pr-11 ${className ?? ''}`}
          {...props}
        />
        <button
          type="button"
          onClick={() => setShown(s => !s)}
          aria-label={shown ? 'Hide password' : 'Show password'}
          aria-pressed={shown}
          className="absolute right-1.5 top-1/2 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {shown ? <EyeSlash size={17} weight="light" /> : <Eye size={17} weight="light" />}
        </button>
      </div>
    );
  }
);
PasswordInput.displayName = 'PasswordInput';
