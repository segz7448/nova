/**
 * Social Group Client Factory
 *
 * The broadcast counterpart to social/client.ts's personal relay client.
 * Personal messages are 1:1 and private (Agent A <-> Agent B, no one
 * else sees it); a group is every current member seeing every message,
 * no matter how many members there are — built for cases like every
 * automaton in a fleet reconciling who covers how much of a shared
 * Alibaba Cloud / OpenRouter bill before it's due, or a parent bringing
 * a freshly spawned child into its family's standing meeting room.
 *
 * Same signed-request model as the personal client: every mutating call
 * is a wallet-signed request against the backend's /social/v1/groups*
 * routes (see backend/src/socialGroups.ts), no shared secret required.
 */

import type { PrivateKeyAccount } from "viem";
import type { SocialGroupClientInterface, GroupSummary, GroupMember, GroupMessage } from "../types.js";
import type { ChainIdentity } from "../identity/chain.js";
import { ResilientHttpClient } from "../chain-utils/http-client.js";
import {
  signGroupCreatePayload,
  signGroupAddMemberPayload,
  signGroupRemoveMemberAuth,
  signGroupSendPayload,
  signGroupPollAuth,
  signIdentityAuth,
  signAgentDeathPayload,
} from "./signing.js";
import { validateRelayUrl } from "./validation.js";

const REQUEST_TIMEOUT_MS = 30_000;

async function readJson(res: Response): Promise<any> {
  return res.json().catch(() => ({ error: res.statusText }));
}

function requireOk(res: Response, body: any, label: string): void {
  if (!res.ok) {
    throw new Error(`${label} failed (${res.status}): ${body?.error || res.statusText}`);
  }
}

export function createSocialGroupClient(
  relayUrl: string,
  account: PrivateKeyAccount | ChainIdentity,
): SocialGroupClientInterface {
  validateRelayUrl(relayUrl);
  const baseUrl = relayUrl.replace(/\/$/, "");
  const httpClient = new ResilientHttpClient();

  return {
    create: async (name, description) => {
      const payload = await signGroupCreatePayload(account, name, description);
      const res = await httpClient.request(`${baseUrl}/v1/groups`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Wallet-Address": payload.from },
        body: JSON.stringify(payload),
        timeout: REQUEST_TIMEOUT_MS,
      });
      const data = await readJson(res);
      requireOk(res, data, "Create group");
      return {
        id: data.id,
        name: data.name,
        description: data.description ?? null,
        creatorAddress: data.creator_address,
        createdAt: data.created_at,
      } satisfies GroupSummary;
    },

    listMine: async () => {
      const auth = await signIdentityAuth(account);
      const res = await httpClient.request(`${baseUrl}/v1/groups`, {
        method: "GET",
        headers: {
          "X-Wallet-Address": auth.address,
          "X-Signature": auth.signature,
          "X-Timestamp": auth.timestamp,
        },
        timeout: REQUEST_TIMEOUT_MS,
      });
      const data = await readJson(res);
      requireOk(res, data, "List groups");
      return (data.groups as any[]).map((g) => ({
        id: g.id,
        name: g.name,
        description: g.description ?? null,
        creatorAddress: g.creator_address,
        createdAt: g.created_at,
        memberCount: g.member_count,
      }));
    },

    addMember: async (groupId, memberAddress) => {
      const payload = await signGroupAddMemberPayload(account, groupId, memberAddress);
      const res = await httpClient.request(`${baseUrl}/v1/groups/${groupId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Wallet-Address": payload.from },
        body: JSON.stringify(payload),
        timeout: REQUEST_TIMEOUT_MS,
      });
      const data = await readJson(res);
      requireOk(res, data, "Add group member");
    },

    removeMember: async (groupId, memberAddress) => {
      const auth = await signGroupRemoveMemberAuth(account, groupId, memberAddress);
      const res = await httpClient.request(`${baseUrl}/v1/groups/${groupId}/members/${memberAddress}`, {
        method: "DELETE",
        headers: {
          "X-Wallet-Address": auth.address,
          "X-Signature": auth.signature,
          "X-Timestamp": auth.timestamp,
        },
        timeout: REQUEST_TIMEOUT_MS,
      });
      const data = await readJson(res);
      requireOk(res, data, "Remove group member");
    },

    listMembers: async (groupId) => {
      const auth = await signIdentityAuth(account);
      const res = await httpClient.request(`${baseUrl}/v1/groups/${groupId}/members`, {
        method: "GET",
        headers: {
          "X-Wallet-Address": auth.address,
          "X-Signature": auth.signature,
          "X-Timestamp": auth.timestamp,
        },
        timeout: REQUEST_TIMEOUT_MS,
      });
      const data = await readJson(res);
      requireOk(res, data, "List group members");
      return (data.members as any[]).map(
        (m): GroupMember => ({ agentAddress: m.agent_address, addedBy: m.added_by, joinedAt: m.joined_at }),
      );
    },

    send: async (groupId, content, replyTo) => {
      const payload = await signGroupSendPayload(account, groupId, content, replyTo);
      const res = await httpClient.request(`${baseUrl}/v1/groups/${groupId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Wallet-Address": payload.from },
        body: JSON.stringify(payload),
        timeout: REQUEST_TIMEOUT_MS,
      });
      const data = await readJson(res);
      requireOk(res, data, "Send group message");
      return { id: data.id };
    },

    poll: async (groupId, cursor, limit) => {
      const auth = await signGroupPollAuth(account, groupId);
      const res = await httpClient.request(`${baseUrl}/v1/groups/${groupId}/messages/poll`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Wallet-Address": auth.address,
          "X-Signature": auth.signature,
          "X-Timestamp": auth.timestamp,
        },
        body: JSON.stringify({ cursor, limit }),
        timeout: REQUEST_TIMEOUT_MS,
      });
      const data = await readJson(res);
      requireOk(res, data, "Poll group");
      const messages: GroupMessage[] = (data.messages as any[]).map((m) => ({
        id: m.id,
        groupId: m.groupId,
        from: m.from,
        content: m.content,
        signedAt: m.signedAt,
        createdAt: m.createdAt,
        replyTo: m.replyTo,
      }));
      return { messages, nextCursor: data.next_cursor };
    },

    unreadCount: async (groupId) => {
      const auth = await signGroupPollAuth(account, groupId);
      const res = await httpClient.request(`${baseUrl}/v1/groups/${groupId}/messages/count`, {
        method: "GET",
        headers: {
          "X-Wallet-Address": auth.address,
          "X-Signature": auth.signature,
          "X-Timestamp": auth.timestamp,
        },
        timeout: REQUEST_TIMEOUT_MS,
      });
      const data = await readJson(res);
      requireOk(res, data, "Group unread count");
      return data.unread;
    },

    reportDeath: async (agentAddress) => {
      const payload = await signAgentDeathPayload(account, agentAddress);
      const res = await httpClient.request(`${baseUrl}/v1/agents/${payload.target}/death`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Wallet-Address": payload.from },
        body: JSON.stringify({ signed_at: payload.signed_at, signature: payload.signature }),
        timeout: REQUEST_TIMEOUT_MS,
      });
      const data = await readJson(res);
      requireOk(res, data, "Report agent death");
      return { removedFromGroups: data.removed_from_groups ?? [] };
    },
  };
}
