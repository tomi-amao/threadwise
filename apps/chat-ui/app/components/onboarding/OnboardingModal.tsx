/**
 * Onboarding Modal Component
 *
 * Multi-step onboarding modal that slides between questions.
 * Collects additional company details after signup.
 */

import React, { useState, useCallback } from 'react';
import {
  Buildings,
  Globe,
  Users,
  Briefcase,
  ArrowRight,
  ArrowLeft,
  SpinnerGap,
  CheckCircle,
  Sparkle,
} from 'phosphor-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '~/components/ui/dialog';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Textarea } from '~/components/ui/textarea';
import { useAuth } from '~/providers/AuthProvider';
import type { IndustryType, EmployeeCountRange, OnboardingData } from '~/types/auth';

interface OnboardingModalProps {
  open: boolean;
  onComplete: () => void;
}

const INDUSTRIES: { value: IndustryType; label: string }[] = [
  { value: 'technology', label: 'Technology' },
  { value: 'healthcare', label: 'Healthcare' },
  { value: 'finance', label: 'Finance & Banking' },
  { value: 'retail', label: 'Retail & E-commerce' },
  { value: 'manufacturing', label: 'Manufacturing' },
  { value: 'education', label: 'Education' },
  { value: 'real_estate', label: 'Real Estate' },
  { value: 'hospitality', label: 'Hospitality' },
  { value: 'consulting', label: 'Consulting' },
  { value: 'other', label: 'Other' },
];

const EMPLOYEE_COUNTS: { value: EmployeeCountRange; label: string }[] = [
  { value: '1-10', label: '1-10 employees' },
  { value: '11-50', label: '11-50 employees' },
  { value: '51-200', label: '51-200 employees' },
  { value: '201-500', label: '201-500 employees' },
  { value: '501-1000', label: '501-1000 employees' },
  { value: '1000+', label: '1000+ employees' },
];

const TOTAL_STEPS = 5;

export function OnboardingModal({ open, onComplete }: OnboardingModalProps) {
  const { entity, updateEntity } = useAuth();
  const [currentStep, setCurrentStep] = useState(0);
  const [direction, setDirection] = useState<'next' | 'prev'>('next');
  const [isAnimating, setIsAnimating] = useState(false);
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState<OnboardingData>({
    industry: null,
    description: '',
    website: '',
    country: '',
    employeeCount: null,
  });

  const goToNextStep = useCallback(() => {
    if (currentStep < TOTAL_STEPS - 1 && !isAnimating) {
      setDirection('next');
      setIsAnimating(true);
      setTimeout(() => {
        setCurrentStep(prev => prev + 1);
        setIsAnimating(false);
      }, 300);
    }
  }, [currentStep, isAnimating]);

  const goToPrevStep = useCallback(() => {
    if (currentStep > 0 && !isAnimating) {
      setDirection('prev');
      setIsAnimating(true);
      setTimeout(() => {
        setCurrentStep(prev => prev - 1);
        setIsAnimating(false);
      }, 300);
    }
  }, [currentStep, isAnimating]);

  const handleIndustrySelect = (industry: IndustryType) => {
    setFormData(prev => ({ ...prev, industry }));
    setTimeout(goToNextStep, 150);
  };

  const handleEmployeeCountSelect = (employeeCount: EmployeeCountRange) => {
    setFormData(prev => ({ ...prev, employeeCount }));
  };

  const handleSubmit = async () => {
    setLoading(true);
    try {
      const { error } = await updateEntity({
        industry: formData.industry,
        description: formData.description || null,
        website: formData.website || null,
        country: formData.country || null,
        employee_count: formData.employeeCount,
        onboarding_completed: true,
        updated_at: new Date().toISOString(),
      });

      if (!error) {
        onComplete();
      } else {
        console.error('Failed to update entity:', error);
      }
    } catch (err) {
      console.error('Error during onboarding:', err);
    } finally {
      setLoading(false);
    }
  };

  const canProceed = () => {
    switch (currentStep) {
      case 0:
        return formData.industry !== null;
      case 1:
        return true; // Description is optional
      case 2:
        return true; // Website is optional
      case 3:
        return formData.country.trim() !== '';
      case 4:
        return formData.employeeCount !== null;
      default:
        return false;
    }
  };

  const renderStepContent = () => {
    const slideClass = isAnimating
      ? direction === 'next'
        ? 'animate-slide-out-left'
        : 'animate-slide-out-right'
      : 'animate-slide-in';

    switch (currentStep) {
      case 0:
        return (
          <div className={`space-y-4 ${slideClass}`}>
            <div className="text-center mb-6">
              <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/10 mb-4">
                <Briefcase size={28} className="text-primary" weight="duotone" />
              </div>
              <h3 className="text-xl font-semibold text-foreground">What industry are you in?</h3>
              <p className="text-sm text-muted-foreground mt-1">
                This helps us tailor your experience
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {INDUSTRIES.map(industry => (
                <button
                  key={industry.value}
                  onClick={() => handleIndustrySelect(industry.value)}
                  className={`p-3 rounded-xl border text-left transition-all hover:border-primary hover:bg-primary/5 ${
                    formData.industry === industry.value
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-card'
                  }`}
                >
                  <span className="text-sm font-medium">{industry.label}</span>
                </button>
              ))}
            </div>
          </div>
        );

      case 1:
        return (
          <div className={`space-y-4 ${slideClass}`}>
            <div className="text-center mb-6">
              <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/10 mb-4">
                <Buildings size={28} className="text-primary" weight="duotone" />
              </div>
              <h3 className="text-xl font-semibold text-foreground">
                Tell us about {entity?.name || 'your company'}
              </h3>
              <p className="text-sm text-muted-foreground mt-1">
                A brief description of what you do
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="description" className="sr-only">
                Company Description
              </Label>
              <Textarea
                id="description"
                placeholder="We help businesses streamline their operations..."
                value={formData.description}
                onChange={e => setFormData(prev => ({ ...prev, description: e.target.value }))}
                rows={4}
                className="resize-none"
              />
              <p className="text-xs text-muted-foreground">Optional - You can skip this for now</p>
            </div>
          </div>
        );

      case 2:
        return (
          <div className={`space-y-4 ${slideClass}`}>
            <div className="text-center mb-6">
              <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/10 mb-4">
                <Globe size={28} className="text-primary" weight="duotone" />
              </div>
              <h3 className="text-xl font-semibold text-foreground">What's your website?</h3>
              <p className="text-sm text-muted-foreground mt-1">
                Help us learn more about your business
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="website" className="sr-only">
                Website URL
              </Label>
              <div className="relative">
                <Globe
                  size={20}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  id="website"
                  type="url"
                  placeholder="https://yourcompany.com"
                  value={formData.website}
                  onChange={e => setFormData(prev => ({ ...prev, website: e.target.value }))}
                  className="pl-10"
                />
              </div>
              <p className="text-xs text-muted-foreground">Optional - You can add this later</p>
            </div>
          </div>
        );

      case 3:
      case 4:
        return (
          <div className={`space-y-4 ${slideClass}`}>
            <div className="text-center mb-6">
              <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/10 mb-4">
                <Users size={28} className="text-primary" weight="duotone" />
              </div>
              <h3 className="text-xl font-semibold text-foreground">How big is your team?</h3>
              <p className="text-sm text-muted-foreground mt-1">
                This helps us understand your scale
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {EMPLOYEE_COUNTS.map(option => (
                <button
                  key={option.value}
                  onClick={() => handleEmployeeCountSelect(option.value)}
                  className={`p-3 rounded-xl border text-left transition-all hover:border-primary hover:bg-primary/5 ${
                    formData.employeeCount === option.value
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-card'
                  }`}
                >
                  <span className="text-sm font-medium">{option.label}</span>
                </button>
              ))}
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent
        hideCloseButton
        className="sm:max-w-md overflow-hidden"
        onPointerDownOutside={e => e.preventDefault()}
        onEscapeKeyDown={e => e.preventDefault()}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Complete your profile</DialogTitle>
          <DialogDescription>Help us personalize your ThreadWise experience</DialogDescription>
        </DialogHeader>

        {/* Progress indicator */}
        <div className="flex items-center justify-center gap-1.5 mb-2">
          {Array.from({ length: TOTAL_STEPS }).map((_, index) => (
            <div
              key={index}
              className={`h-1.5 rounded-full transition-all duration-300 ${
                index <= currentStep ? 'w-8 bg-primary' : 'w-1.5 bg-muted'
              }`}
            />
          ))}
        </div>

        {/* Step content with slide animation */}
        <div className="min-h-[320px] flex flex-col justify-between">
          <div className="flex-1">{renderStepContent()}</div>

          {/* Navigation buttons */}
          <div className="flex items-center justify-between pt-4 border-t border-border mt-4">
            <Button
              variant="ghost"
              onClick={goToPrevStep}
              disabled={currentStep === 0 || isAnimating}
              className={currentStep === 0 ? 'invisible' : ''}
            >
              <ArrowLeft size={18} />
              Back
            </Button>

            {currentStep === TOTAL_STEPS - 1 ? (
              <Button onClick={handleSubmit} disabled={!canProceed() || loading}>
                {loading ? (
                  <>
                    <SpinnerGap size={18} className="animate-spin" />
                    Completing...
                  </>
                ) : (
                  <>
                    <CheckCircle size={18} weight="duotone" />
                    Complete Setup
                  </>
                )}
              </Button>
            ) : (
              <Button onClick={goToNextStep} disabled={!canProceed() || isAnimating}>
                {currentStep === 0 && formData.industry ? (
                  'Continue'
                ) : (
                  <>
                    {currentStep > 0 ? 'Continue' : 'Next'}
                    <ArrowRight size={18} />
                  </>
                )}
              </Button>
            )}
          </div>
        </div>

        {/* Welcome message at bottom */}
        <div className="flex items-center justify-center gap-2 pt-2 text-xs text-muted-foreground">
          <Sparkle size={14} weight="duotone" className="text-primary" />
          <span>Welcome to ThreadWise!</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
