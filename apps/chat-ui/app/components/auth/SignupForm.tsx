/**
 * Signup Form Component
 *
 * Handles new user registration with company name requirement.
 * Creates both user account and associated entity.
 */

import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router';
import { useAuth } from '~/providers/AuthProvider';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { PasswordInput } from '~/components/ui/password-input';

export function SignupForm() {
  const navigate = useNavigate();
  const { signUp } = useAuth();
  const [formData, setFormData] = useState({
    fullName: '',
    companyName: '',
    email: '',
    password: '',
    confirmPassword: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData(prev => ({
      ...prev,
      [e.target.name]: e.target.value,
    }));
  };

  const validateForm = (): string | null => {
    if (!formData.fullName.trim()) {
      return 'Please enter your full name';
    }
    if (!formData.companyName.trim()) {
      return 'Please enter your company name';
    }
    if (!formData.email.trim()) {
      return 'Please enter your email address';
    }
    if (formData.password.length < 6) {
      return 'Password must be at least 6 characters';
    }
    if (formData.password !== formData.confirmPassword) {
      return 'Passwords do not match';
    }
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const validationError = validateForm();
    if (validationError) {
      setError(validationError);
      return;
    }

    setLoading(true);

    try {
      const { error } = await signUp(
        formData.email,
        formData.password,
        formData.fullName,
        formData.companyName
      );

      if (error) {
        setError(error.message);
      } else {
        navigate('/dashboard');
      }
    } catch {
      setError('An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-full max-w-[400px]">
      <div className="eyebrow">Create an account</div>
      <h1 className="mt-3 font-serif text-[clamp(34px,4vw,44px)] font-light leading-[1.05] tracking-[-0.03em]">
        Start your books.
      </h1>
      <p className="mt-3 text-[16px] text-text-2">
        Your business, set up in a minute. Connect a store when you are ready.
      </p>

      <form onSubmit={handleSubmit} className="mt-8 space-y-5" noValidate>
        <Field label="Your name">
          <Input
            name="fullName"
            autoComplete="name"
            placeholder="Ada Lovelace"
            value={formData.fullName}
            onChange={handleChange}
            required
          />
        </Field>
        <Field label="Business name" hint="This becomes your business in ThreadWise.">
          <Input
            name="companyName"
            autoComplete="organization"
            placeholder="Atelier North"
            value={formData.companyName}
            onChange={handleChange}
            required
          />
        </Field>
        <Field label="Email">
          <Input
            type="email"
            name="email"
            autoComplete="email"
            placeholder="you@company.com"
            value={formData.email}
            onChange={handleChange}
            required
          />
        </Field>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Password" hint="At least 6 characters.">
            <PasswordInput
              name="password"
              autoComplete="new-password"
              value={formData.password}
              onChange={handleChange}
              required
              minLength={6}
            />
          </Field>
          <Field label="Confirm password">
            <PasswordInput
              name="confirmPassword"
              autoComplete="new-password"
              value={formData.confirmPassword}
              onChange={handleChange}
              required
            />
          </Field>
        </div>

        {error && (
          <p
            role="alert"
            className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-[14px] text-destructive"
          >
            {error}
          </p>
        )}

        <Button type="submit" size="lg" className="w-full" disabled={loading}>
          {loading ? 'Creating your account…' : 'Create account'}
        </Button>
      </form>

      <p className="mt-8 text-[15px] text-text-2">
        Already have an account?{' '}
        <Link
          to="/login"
          className="text-accent-text underline underline-offset-4 hover:text-foreground"
        >
          Sign in
        </Link>
      </p>
    </div>
  );
}
