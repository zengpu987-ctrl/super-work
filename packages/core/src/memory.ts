/** 记忆系统。 */

export type MemoryKind = "fact" | "preference" | "decision" | "insight";

export const MEMORY_KIND_LABEL: Record<MemoryKind, string> = {
  fact: "事实",
  preference: "偏好",
  decision: "决策",
  insight: "洞察",
};

export interface MemorySpace {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  count?: number;
}

export interface MemoryEntry {
  id: string;
  spaceId: string;
  kind: MemoryKind;
  content: string;
  tags: string[];
  /** 1~5 */
  importance: number;
  source: "user" | "auto" | "import";
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  useCount?: number;
}

export interface MemoryHit {
  memory: MemoryEntry;
  score: number;
}

export interface MemoryCreateRequest {
  spaceId?: string;
  kind?: MemoryKind;
  content: string;
  tags?: string[];
  importance?: number;
  source?: "user" | "auto" | "import";
}

export interface MemoryUpdateRequest {
  kind?: MemoryKind;
  content?: string;
  tags?: string[];
  importance?: number;
  enabled?: boolean;
  spaceId?: string;
}

export interface MemoryStats {
  spaces: MemorySpace[];
  total: number;
  enabled: number;
  byKind: Record<MemoryKind, number>;
  lastUsedAt?: number;
}

export interface DshMemorySeed {
  version: 1;
  exportedAt: number;
  memories: Array<{
    kind: MemoryKind;
    content: string;
    tags?: string[];
    importance?: number;
    space?: string;
  }>;
}
