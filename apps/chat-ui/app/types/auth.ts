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
  created_at: string;
}

export interface UserWithProfile {
  id: string;
  email: string;
  profile: UserProfile | null;
  entity: Entity | null;
}
