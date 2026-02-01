/**
 * Authentication Provider
 *
 * Manages authentication state using Supabase Auth.
 * Provides user context including profile and entity information.
 * Only runs on client-side to avoid SSR issues.
 */

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { User, Session, AuthError, SupabaseClient } from '@supabase/supabase-js';
import { type UserProfile, type Entity } from '~/types/auth';

interface AuthContextType {
  user: User | null;
  profile: UserProfile | null;
  entity: Entity | null;
  session: Session | null;
  loading: boolean;
  needsOnboarding: boolean;
  signUp: (
    email: string,
    password: string,
    fullName: string,
    companyName: string
  ) => Promise<{ error: AuthError | null }>;
  signIn: (email: string, password: string) => Promise<{ error: AuthError | null }>;
  signOut: () => Promise<void>;
  updateProfile: (updates: Partial<UserProfile>) => Promise<{ error: Error | null }>;
  updateEntity: (updates: Partial<Entity>) => Promise<{ error: Error | null }>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

interface AuthProviderProps {
  children: React.ReactNode;
}

// Lazy import supabase client to avoid SSR issues
let supabaseClient: SupabaseClient | null = null;

async function getSupabase(): Promise<SupabaseClient> {
  if (supabaseClient) return supabaseClient;

  const { getSupabaseBrowserClient } = await import('~/lib/supabase');
  supabaseClient = getSupabaseBrowserClient();
  return supabaseClient;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [entity, setEntity] = useState<Entity | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [isClient, setIsClient] = useState(false);

  // Fetch user profile and entity
  const fetchProfileAndEntity = useCallback(async (user: User) => {
    try {
      const supabase = await getSupabase();

      // Create profile from user metadata
      const userProfile: UserProfile = {
        id: user.id,
        user_id: user.id,
        entity_id: null, // Will be set after entity fetch
        full_name: user.user_metadata?.full_name || '',
        role: user.user_metadata?.role || 'owner',
        created_at: user.created_at,
        updated_at: user.updated_at || user.created_at,
      };

      // Fetch entity owned by this user
      const { data: entityData, error: entityError } = await supabase
        .from('entities')
        .select('*')
        .eq('owner_user_id', user.id)
        .single();

      if (entityError) {
        console.error('Error fetching entity:', entityError);
        setEntity(null);
      } else {
        setEntity(entityData);
        // Update profile with entity_id
        userProfile.entity_id = entityData.id;
      }

      setProfile(userProfile);
    } catch (error) {
      console.error('Error in fetchProfileAndEntity:', error);
    }
  }, []);

  // Client-side detection
  useEffect(() => {
    setIsClient(true);
  }, []);

  // Initialize auth state (client-side only)
  useEffect(() => {
    if (!isClient) return;

    let subscription: { unsubscribe: () => void } | null = null;

    const initAuth = async () => {
      try {
        const supabase = await getSupabase();

        // Get initial session
        const {
          data: { session },
        } = await supabase.auth.getSession();
        setSession(session);
        setUser(session?.user ?? null);
        console.log(session?.user);

        if (session?.user) {
          await fetchProfileAndEntity(session.user);
        }
        setLoading(false);

        // Listen for auth changes
        const { data } = supabase.auth.onAuthStateChange(async (event, session) => {
          setSession(session);
          setUser(session?.user ?? null);

          if (session?.user) {
            await fetchProfileAndEntity(session.user);
          } else {
            setProfile(null);
            setEntity(null);
          }

          setLoading(false);
        });

        subscription = data.subscription;
      } catch (error) {
        console.error('Error initializing auth:', error);
        setLoading(false);
      }
    };

    initAuth();

    return () => {
      subscription?.unsubscribe();
    };
  }, [isClient, fetchProfileAndEntity]);

  // Sign up with company name
  const signUp = async (
    email: string,
    password: string,
    fullName: string,
    companyName: string
  ): Promise<{ error: AuthError | null }> => {
    const supabase = await getSupabase();

    try {
      // First sign up the user
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            full_name: fullName,
            role: 'owner',
          },
        },
      });

      if (authError || !authData.user) {
        return { error: authError };
      }

      // Then create the entity with the user as owner
      const { error: entityError } = await supabase.from('entities').insert({
        name: companyName,
        owner_user_id: authData.user.id,
        onboarding_completed: false,
      });

      if (entityError) {
        return { error: entityError as any };
      }

      return { error: null };
    } catch (err) {
      return { error: err as AuthError };
    }
  };

  // Sign in
  const signIn = async (email: string, password: string): Promise<{ error: AuthError | null }> => {
    const supabase = await getSupabase();
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    return { error };
  };

  // Sign out
  const signOut = async () => {
    const supabase = await getSupabase();
    await supabase.auth.signOut();
    setProfile(null);
    setEntity(null);
  };

  // Update profile
  const updateProfile = async (updates: Partial<UserProfile>): Promise<{ error: Error | null }> => {
    if (!user) {
      return { error: new Error('Not authenticated') };
    }

    const supabase = await getSupabase();
    const { error } = await supabase.auth.updateUser({
      data: {
        ...user.user_metadata,
        ...updates,
        updated_at: new Date().toISOString(),
      },
    });

    if (!error) {
      await fetchProfileAndEntity(user);
    }

    return { error: error as Error | null };
  };

  // Update entity
  const updateEntity = async (updates: Partial<Entity>): Promise<{ error: Error | null }> => {
    if (!entity) {
      return { error: new Error('No entity associated') };
    }

    const supabase = await getSupabase();
    const { error } = await supabase.from('entities').update(updates).eq('id', entity.id);

    if (!error && user) {
      await fetchProfileAndEntity(user);
    }

    return { error };
  };

  // Refresh profile
  const refreshProfile = async () => {
    if (user) {
      await fetchProfileAndEntity(user);
    }
  };

  // Check if onboarding is needed (user has entity but hasn't completed onboarding)
  const needsOnboarding = Boolean(user && entity && entity.onboarding_completed === false);

  console.log(entity);

  const value: AuthContextType = {
    user,
    profile,
    entity,
    session,
    loading,
    needsOnboarding,
    signUp,
    signIn,
    signOut,
    updateProfile,
    updateEntity,
    refreshProfile,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
