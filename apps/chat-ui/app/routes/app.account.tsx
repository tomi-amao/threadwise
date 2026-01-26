/**
 * Account Route (Protected)
 *
 * User account settings and profile management.
 */

import type { MetaFunction } from 'react-router';
import { useState } from 'react';
import { User, Buildings, EnvelopeSimple, SpinnerGap, CheckCircle } from 'phosphor-react';
import { useAuth } from '~/providers/AuthProvider';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';

export const meta: MetaFunction = () => {
  return [
    { title: 'Account Settings - ThreadWise' },
    { name: 'description', content: 'Manage your account settings' },
  ];
};

export default function AccountPage() {
  const { user, profile, entity, updateProfile, updateEntity } = useAuth();
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    fullName: profile?.full_name || '',
    companyName: entity?.name || '',
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData(prev => ({
      ...prev,
      [e.target.name]: e.target.value,
    }));
    setSuccess(false);
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(false);

    try {
      // Update profile if name changed
      if (formData.fullName !== profile?.full_name) {
        const { error: profileError } = await updateProfile({
          full_name: formData.fullName,
        });
        if (profileError) {
          setError(profileError.message);
          setLoading(false);
          return;
        }
      }

      // Update entity if company name changed
      if (formData.companyName !== entity?.name) {
        const { error: entityError } = await updateEntity({
          name: formData.companyName,
        });
        if (entityError) {
          setError(entityError.message);
          setLoading(false);
          return;
        }
      }

      setSuccess(true);
    } catch (err) {
      setError('An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background p-6 lg:p-8">
      <div className="max-w-2xl">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-foreground">Account Settings</h1>
          <p className="text-muted-foreground mt-2">
            Manage your profile and organization settings.
          </p>
        </div>

        {/* Profile Section */}
        <div className="rounded-2xl border border-border bg-card p-6 mb-6">
          <h2 className="text-xl font-semibold text-foreground mb-6 flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
              <User size={20} className="text-primary" weight="duotone" />
            </div>
            Profile Information
          </h2>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="email" className="text-sm font-medium">
                Email address
              </Label>
              <div className="relative">
                <EnvelopeSimple
                  size={20}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  id="email"
                  type="email"
                  value={user?.email || ''}
                  className="pl-10 bg-muted/50"
                  disabled
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Email cannot be changed. Contact support if needed.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="fullName" className="text-sm font-medium">
                Full name
              </Label>
              <div className="relative">
                <User
                  size={20}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  id="fullName"
                  name="fullName"
                  type="text"
                  placeholder="Your name"
                  value={formData.fullName}
                  onChange={handleChange}
                  className="pl-10"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="companyName" className="text-sm font-medium">
                Company name
              </Label>
              <div className="relative">
                <Buildings
                  size={20}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  id="companyName"
                  name="companyName"
                  type="text"
                  placeholder="Your company"
                  value={formData.companyName}
                  onChange={handleChange}
                  className="pl-10"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                This is your organization name in ThreadWise.
              </p>
            </div>

            {error && (
              <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm">
                {error}
              </div>
            )}

            {success && (
              <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/20 text-green-500 text-sm flex items-center gap-2">
                <CheckCircle size={18} weight="duotone" />
                Settings saved successfully.
              </div>
            )}

            <Button type="submit" disabled={loading}>
              {loading ? (
                <>
                  <SpinnerGap size={18} className="animate-spin" />
                  Saving...
                </>
              ) : (
                'Save changes'
              )}
            </Button>
          </form>
        </div>

        {/* Account Info Section */}
        <div className="rounded-2xl border border-border bg-card p-6">
          <h2 className="text-xl font-semibold text-foreground mb-6 flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center">
              <Buildings size={20} className="text-muted-foreground" weight="duotone" />
            </div>
            Account Details
          </h2>

          <dl className="space-y-4">
            <div>
              <dt className="text-sm font-medium text-muted-foreground">Role</dt>
              <dd className="text-foreground capitalize">{profile?.role || 'Owner'}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-muted-foreground">Member since</dt>
              <dd className="text-foreground">
                {profile?.created_at
                  ? new Date(profile.created_at).toLocaleDateString('en-US', {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                    })
                  : 'N/A'}
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  );
}
