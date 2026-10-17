/** The states a collection can be in. Shared by the server (validation) and the page (choices). */

export type CollectionStatus = 'draft' | 'planned' | 'active' | 'completed' | 'archived';

export const COLLECTION_STATUSES: CollectionStatus[] = [
  'draft',
  'planned',
  'active',
  'completed',
  'archived',
];
