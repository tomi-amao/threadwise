/**
 * Auth Types
 *
 * TypeScript interfaces for authentication-related data
 */

export interface UserProfile {
  id: string;
  user_id: string;
  entity_id: string | null;
  full_name: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  created_at: string;
  updated_at: string;
}

export interface Entity {
  id: string;
  name: string;
  owner_user_id: string;
  industry: string | null;
  description: string | null;
  website: string | null;
  employee_count: string | null;
  onboarding_completed: boolean;
  created_at: string;
  updated_at: string;
}

export type IndustryType =
  | 'technology'
  | 'healthcare'
  | 'finance'
  | 'retail'
  | 'manufacturing'
  | 'education'
  | 'real_estate'
  | 'hospitality'
  | 'consulting'
  | 'other';

export type EmployeeCountRange = '1-10' | '11-50' | '51-200' | '201-500' | '501-1000' | '1000+';

export interface OnboardingData {
  industry: IndustryType | null;
  description: string;
  website: string;
  country: string;
  employeeCount: EmployeeCountRange | null;
}

export interface UserWithProfile {
  id: string;
  email: string;
  profile: UserProfile | null;
  entity: Entity | null;
}
