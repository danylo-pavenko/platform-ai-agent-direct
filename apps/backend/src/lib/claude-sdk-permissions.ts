/**
 * SDK canUseTool gate for customer MCP tools.
 * Mutations still run in conversation.ts (side-effect order). This module only
 * allows/denies the native tool_use so the model cannot skip required args or
 * treat a second book_appointment as a reschedule.
 */

import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_SDK_DISALLOWED_TOOLS } from './claude-runtime.js';
import {
  canonicalToolName,
  isLookupToolName,
  isProfileToolName,
  isTerminalToolName,
} from './tool-definitions.js';

export interface ExistingBookingSnapshot {
  date: string;
  time: string;
}

export interface SdkToolPermissionPolicy {
  allowNames: ReadonlySet<string>;
  mutationsAllowed?: boolean;
  existingBooking?: ExistingBookingSnapshot | null;
}

const RESCHEDULE_DENY =
  'Немає reschedule tool. Інша дата/час = новий візит у CRM, старий лишиться. Викликай request_handoff.';

const FORCE_DENY =
  'force=true заборонено на агентному шляху. Запропонуй інший слот або request_handoff.';

function asNonEmptyString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function normalizeUaDate(raw: string): string {
  const t = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (iso) return `${iso[3]}.${iso[2]}.${iso[1]}`;
  return t;
}

function normalizeTime(raw: string): string {
  const t = raw.trim();
  const m = /^(\d{1,2}):(\d{2})/.exec(t);
  if (!m) return t;
  return `${m[1]!.padStart(2, '0')}:${m[2]}`;
}

export function isRescheduleBookAttempt(
  args: Record<string, unknown>,
  existing: ExistingBookingSnapshot | null | undefined,
): boolean {
  if (!existing) return false;
  const nextDate = normalizeUaDate(asNonEmptyString(args.date));
  const nextTime = normalizeTime(asNonEmptyString(args.time));
  if (!nextDate || !nextTime) return false;
  const prevDate = normalizeUaDate(existing.date);
  const prevTime = normalizeTime(existing.time);
  return nextDate !== prevDate || nextTime !== prevTime;
}

function deny(message: string): PermissionResult {
  return { behavior: 'deny', message };
}

function allow(input: Record<string, unknown>): PermissionResult {
  return { behavior: 'allow', updatedInput: input };
}

function hasBookServices(args: Record<string, unknown>): boolean {
  if (!Array.isArray(args.services) || args.services.length === 0) return false;
  return args.services.some((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
    const id = asNonEmptyString((row as Record<string, unknown>).id);
    return Boolean(id);
  });
}

function hasCollectItems(args: Record<string, unknown>): boolean {
  if (!Array.isArray(args.items) || args.items.length === 0) return false;
  return args.items.some((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
    const o = row as Record<string, unknown>;
    return Boolean(asNonEmptyString(o.name)) && typeof o.price === 'number';
  });
}

export function evaluateSdkToolPermission(
  rawName: string,
  args: Record<string, unknown>,
  policy: SdkToolPermissionPolicy,
): PermissionResult {
  const name = canonicalToolName(rawName);
  const coding = new Set<string>(CLAUDE_SDK_DISALLOWED_TOOLS);
  if (coding.has(name) || coding.has(rawName)) {
    return deny('Coding tools are disabled on this agent.');
  }
  if (!policy.allowNames.has(name)) {
    return deny(`Tool ${name} is not in this turn's allowlist.`);
  }

  if (isLookupToolName(name) || isProfileToolName(name)) {
    return allow(args);
  }

  if (!isTerminalToolName(name)) {
    return deny(`Unknown tool ${name}.`);
  }

  if (name === 'request_handoff') {
    return allow(args);
  }

  if (policy.mutationsAllowed === false) {
    return deny(
      'Terminal mutation already applied this turn. Reply to the client; do not call book/collect/create_local_order/submit_brief again.',
    );
  }

  if (name === 'book_appointment') {
    if (args.force === true) return deny(FORCE_DENY);
    if (
      !asNonEmptyString(args.customer_name) ||
      !asNonEmptyString(args.phone) ||
      !asNonEmptyString(args.date) ||
      !asNonEmptyString(args.time) ||
      !hasBookServices(args)
    ) {
      return deny(
        'book_appointment потребує customer_name, phone, date (ДД.ММ.РРРР), time і services[{id,…}].',
      );
    }
    if (isRescheduleBookAttempt(args, policy.existingBooking)) {
      return deny(RESCHEDULE_DENY);
    }
    const { force: _force, ...rest } = args;
    return allow(rest);
  }

  if (name === 'collect_order') {
    if (
      !hasCollectItems(args) ||
      !asNonEmptyString(args.customer_name) ||
      !asNonEmptyString(args.phone) ||
      !asNonEmptyString(args.city) ||
      !asNonEmptyString(args.np_branch) ||
      !asNonEmptyString(args.payment_method)
    ) {
      return deny(
        'collect_order потребує items, customer_name, phone, city, np_branch, payment_method.',
      );
    }
    return allow(args);
  }

  if (name === 'create_local_order') {
    if (!asNonEmptyString(args.kind) || !asNonEmptyString(args.summary)) {
      return deny('create_local_order потребує kind і summary.');
    }
    return allow(args);
  }

  // submit_brief — host still sends the model's closing text to the client.
  return allow(args);
}

export function createClaudeSdkCanUseTool(policy: SdkToolPermissionPolicy) {
  return async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> => evaluateSdkToolPermission(toolName, input, policy);
}
