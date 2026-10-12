/**
 * Account Route (Protected)
 *
 * User account settings and profile management.
 */

import type { MetaFunction } from 'react-router';
import { useState } from 'react';
import {
  User,
  Buildings,
  EnvelopeSimple,
  SpinnerGap,
  CheckCircle,
  Briefcase,
  GlobeHemisphereWest,
  TextAlignLeft,
  Users,
} from 'phosphor-react';
import { useAuth } from '~/providers/AuthProvider';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Textarea } from '~/components/ui/textarea';
import type { IndustryType, EmployeeCountRange } from '~/types/auth';

export const meta: MetaFunction = () => {
  return [
    { title: 'Account Settings - ThreadWise' },
    { name: 'description', content: 'Manage your account settings' },
  ];
};

const industryOptions: { value: IndustryType; label: string }[] = [
  { value: 'technology', label: 'Technology' },
  { value: 'healthcare', label: 'Healthcare' },
  { value: 'finance', label: 'Finance' },
  { value: 'retail', label: 'Retail' },
  { value: 'manufacturing', label: 'Manufacturing' },
  { value: 'education', label: 'Education' },
  { value: 'real_estate', label: 'Real Estate' },
  { value: 'hospitality', label: 'Hospitality' },
  { value: 'consulting', label: 'Consulting' },
  { value: 'other', label: 'Other' },
];

const employeeCountOptions: { value: EmployeeCountRange; label: string }[] = [
  { value: '1-10', label: '1-10 employees' },
  { value: '11-50', label: '11-50 employees' },
  { value: '51-200', label: '51-200 employees' },
  { value: '201-500', label: '201-500 employees' },
  { value: '501-1000', label: '501-1000 employees' },
  { value: '1000+', label: '1000+ employees' },
];

export default function AccountPage() {
  const { user, profile, entity, updateProfile, updateEntity } = useAuth();
  const [profileLoading, setProfileLoading] = useState(false);
  const [entityLoading, setEntityLoading] = useState(false);
  const [profileSuccess, setProfileSuccess] = useState(false);
  const [entitySuccess, setEntitySuccess] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [entityError, setEntityError] = useState<string | null>(null);

  const [profileFormData, setProfileFormData] = useState({
    fullName: profile?.full_name || '',
  });

  const [entityFormData, setEntityFormData] = useState({
    companyName: entity?.name || '',
    industry: (entity?.industry as IndustryType) || null,
    description: entity?.description || '',
    website: entity?.website || '',
    employeeCount: (entity?.employee_count as EmployeeCountRange) || null,
  });

  const handleProfileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setProfileFormData(prev => ({
      ...prev,
      [e.target.name]: e.target.value,
    }));
    setProfileSuccess(false);
    setProfileError(null);
  };

  const handleEntityChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
  ) => {
    const { name, value } = e.target;
    setEntityFormData(prev => ({
      ...prev,
      [name]: value || null,
    }));
    setEntitySuccess(false);
    setEntityError(null);
  };

  const handleProfileSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setProfileLoading(true);
    setProfileError(null);
    setProfileSuccess(false);

    try {
      if (profileFormData.fullName !== profile?.full_name) {
        const { error } = await updateProfile({
          full_name: profileFormData.fullName,
        });
        if (error) {
          setProfileError(error.message);
          setProfileLoading(false);
          return;
        }
      }
      setProfileSuccess(true);
    } catch (err) {
      setProfileError('An unexpected error occurred');
    } finally {
      setProfileLoading(false);
    }
  };

  const handleEntitySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setEntityLoading(true);
    setEntityError(null);
    setEntitySuccess(false);

    try {
      const updates: Partial<{
        name: string;
        industry: string;
        description: string;
        website: string;
        employee_count: string;
      }> = {};

      if (entityFormData.companyName !== entity?.name) {
        updates.name = entityFormData.companyName;
      }
      if (entityFormData.industry !== entity?.industry) {
        updates.industry = entityFormData.industry || '';
      }
      if (entityFormData.description !== entity?.description) {
        updates.description = entityFormData.description;
      }
      if (entityFormData.website !== entity?.website) {
        updates.website = entityFormData.website;
      }
      if (entityFormData.employeeCount !== entity?.employee_count) {
        updates.employee_count = entityFormData.employeeCount || '';
      }

      if (Object.keys(updates).length > 0) {
        const { error } = await updateEntity(updates);
        if (error) {
          setEntityError(error.message);
          setEntityLoading(false);
          return;
        }
      }

      setEntitySuccess(true);
    } catch (err) {
      setEntityError('An unexpected error occurred');
    } finally {
      setEntityLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background p-6 lg:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-foreground">Account Settings</h1>
          <p className="text-muted-foreground mt-2">
            Manage your personal profile and organization information.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Profile Section */}
          <div className="rounded-2xl border border-border bg-card p-6">
            <h2 className="text-xl font-semibold text-foreground mb-6 flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                <User size={20} className="text-primary" weight="duotone" />
              </div>
              Personal Profile
            </h2>

            <form onSubmit={handleProfileSubmit} className="space-y-5">
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
                    value={profileFormData.fullName}
                    onChange={handleProfileChange}
                    className="pl-10"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-sm font-medium text-muted-foreground">Role</Label>
                <p className="text-foreground capitalize">{profile?.role || 'Owner'}</p>
              </div>

              <div className="space-y-2">
                <Label className="text-sm font-medium text-muted-foreground">Member since</Label>
                <p className="text-foreground">
                  {profile?.created_at
                    ? new Date(profile.created_at).toLocaleDateString('en-US', {
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric',
                      })
                    : 'N/A'}
                </p>
              </div>

              {profileError && (
                <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm">
                  {profileError}
                </div>
              )}

              {profileSuccess && (
                <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/20 text-green-500 text-sm flex items-center gap-2">
                  <CheckCircle size={18} weight="duotone" />
                  Profile updated successfully.
                </div>
              )}

              <Button type="submit" disabled={profileLoading} className="w-full">
                {profileLoading ? (
                  <>
                    <SpinnerGap size={18} className="animate-spin" />
                    Saving...
                  </>
                ) : (
                  'Save profile'
                )}
              </Button>
            </form>
          </div>

          {/* Company/Entity Section */}
          <div className="rounded-2xl border border-border bg-card p-6">
            <h2 className="text-xl font-semibold text-foreground mb-6 flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center">
                <Buildings size={20} className="text-accent-foreground" weight="duotone" />
              </div>
              Company Information
            </h2>

            <form onSubmit={handleEntitySubmit} className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="companyName" className="text-sm font-medium">
                  Company name <span className="text-destructive">*</span>
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
                    value={entityFormData.companyName}
                    onChange={handleEntityChange}
                    className="pl-10"
                    required
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="industry" className="text-sm font-medium">
                  Industry
                </Label>
                <div className="relative">
                  <Briefcase
                    size={20}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground z-10"
                  />
                  <select
                    id="industry"
                    name="industry"
                    value={entityFormData.industry || ''}
                    onChange={handleEntityChange}
                    className="w-full pl-10 pr-4 py-2 rounded-lg border border-input bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring appearance-none"
                  >
                    <option value="">Select industry</option>
                    {industryOptions.map(option => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="employeeCount" className="text-sm font-medium">
                  Company size
                </Label>
                <div className="relative">
                  <Users
                    size={20}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground z-10"
                  />
                  <select
                    id="employeeCount"
                    name="employeeCount"
                    value={entityFormData.employeeCount || ''}
                    onChange={handleEntityChange}
                    className="w-full pl-10 pr-4 py-2 rounded-lg border border-input bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring appearance-none"
                  >
                    <option value="">Select size</option>
                    {employeeCountOptions.map(option => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="website" className="text-sm font-medium">
                  Website
                </Label>
                <div className="relative">
                  <GlobeHemisphereWest
                    size={20}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                  />
                  <Input
                    id="website"
                    name="website"
                    type="url"
                    placeholder="https://example.com"
                    value={entityFormData.website}
                    onChange={handleEntityChange}
                    className="pl-10"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="description" className="text-sm font-medium">
                  Description
                </Label>
                <div className="relative">
                  <TextAlignLeft
                    size={20}
                    className="absolute left-3 top-3 text-muted-foreground"
                  />
                  <Textarea
                    id="description"
                    name="description"
                    placeholder="Brief description of your company..."
                    value={entityFormData.description}
                    onChange={handleEntityChange}
                    className="pl-10 min-h-[100px] resize-none"
                  />
                </div>
              </div>

              {entityError && (
                <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm">
                  {entityError}
                </div>
              )}

              {entitySuccess && (
                <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/20 text-green-500 text-sm flex items-center gap-2">
                  <CheckCircle size={18} weight="duotone" />
                  Company information updated successfully.
                </div>
              )}

              <Button type="submit" disabled={entityLoading} className="w-full">
                {entityLoading ? (
                  <>
                    <SpinnerGap size={18} className="animate-spin" />
                    Saving...
                  </>
                ) : (
                  'Save company info'
                )}
              </Button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
