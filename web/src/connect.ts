import { apiRequest, buildQueryString, refreshAccessToken as doRefresh } from "./api/client";

export { doRefresh as refreshAccessToken };

// ============================================================================
// Memo Service Client
// ============================================================================

export const memoServiceClient = {
  async createMemo(req: { memo: any }) {
    const memo = req.memo || {};
    const body: any = {
      content: memo.content ?? "",
      visibility: visibilityToString(memo.visibility),
    };
    if (memo.createTime) body.createTime = timestampToISO(memo.createTime);
    if (memo.updateTime) body.updateTime = timestampToISO(memo.updateTime);
    if (memo.pinned !== undefined) body.pinned = memo.pinned;
    if (memo.location) body.location = memo.location;
    return apiRequest<any>("POST", "/api/v1/memos", body);
  },

  async listMemos(req: any) {
    const params: Record<string, unknown> = {};
    if (req.pageSize) params.pageSize = req.pageSize;
    if (req.pageToken) params.pageToken = req.pageToken;
    if (req.filter) params.filter = req.filter;
    if (req.orderBy) params.orderBy = req.orderBy;
    if (req.state !== undefined) params.state = stateToString(req.state);
    if (req.showDeleted) params.showDeleted = "true";
    const data = await apiRequest<any>("GET", `/api/v1/memos${buildQueryString(params)}`);
    return {
      memos: (data.memos || []).map(normalizeMemo),
      nextPageToken: data.nextPageToken || "",
      totalSize: data.totalSize || 0,
    };
  },

  async getMemo(req: { name: string }) {
    const id = extractId(req.name, "memos/");
    const data = await apiRequest<any>("GET", `/api/v1/memos/${id}`);
    return normalizeMemo(data);
  },

  async updateMemo(req: { memo: any; updateMask?: any }) {
    const memo = req.memo || {};
    const id = extractId(memo.name, "memos/");
    const body: any = {};
    const paths = req.updateMask?.paths || [];

    if (paths.includes("content") || memo.content !== undefined) body.content = memo.content;
    if (paths.includes("visibility") || memo.visibility !== undefined) body.visibility = visibilityToString(memo.visibility);
    if (paths.includes("pinned") || memo.pinned !== undefined) body.pinned = memo.pinned;
    if (paths.includes("state") || memo.state !== undefined) body.state = stateToString(memo.state);
    if (paths.includes("create_time") && memo.createTime) body.createTime = timestampToISO(memo.createTime);
    if (paths.includes("update_time") && memo.updateTime) body.updateTime = timestampToISO(memo.updateTime);
    if (paths.includes("location") || memo.location !== undefined) body.location = memo.location;

    const data = await apiRequest<any>("PATCH", `/api/v1/memos/${id}`, body);
    return normalizeMemo(data);
  },

  async deleteMemo(req: { name: string }) {
    const id = extractId(req.name, "memos/");
    await apiRequest<any>("DELETE", `/api/v1/memos/${id}`);
  },

  async setMemoAttachments(req: { name: string; attachments: any[] }) {
    const id = extractId(req.name, "memos/");
    const attachments = (req.attachments || []).map((a: any) => ({
      id: a.id,
      name: a.name,
      uid: a.uid,
    }));
    await apiRequest<any>("PATCH", `/api/v1/memos/${id}/attachments`, { attachments });
  },

  async listMemoAttachments(req: any) {
    const id = extractId(req.name, "memos/");
    const data = await apiRequest<any>("GET", `/api/v1/memos/${id}/attachments`);
    return { attachments: data.attachments || [], nextPageToken: "" };
  },

  async setMemoRelations(req: { name: string; relations: any[] }) {
    const id = extractId(req.name, "memos/");
    const relations = (req.relations || []).map((r: any) => ({
      relatedMemoId: Number(extractId(r.relatedMemo?.name || "", "memos/")),
      type: r.type === 2 ? "COMMENT" : "REFERENCE",
    }));
    await apiRequest<any>("PATCH", `/api/v1/memos/${id}/relations`, { relations });
  },

  async listMemoRelations(req: any) {
    const id = extractId(req.name, "memos/");
    const data = await apiRequest<any>("GET", `/api/v1/memos/${id}/relations`);
    return { relations: data.relations || [], nextPageToken: "" };
  },

  async createMemoComment(req: { name: string; comment: any }) {
    const id = extractId(req.name, "memos/");
    const comment = req.comment || {};
    const body: any = {
      content: comment.content ?? "",
      visibility: visibilityToString(comment.visibility),
    };
    if (comment.location) body.location = comment.location;
    const data = await apiRequest<any>("POST", `/api/v1/memos/${id}/comments`, body);
    return normalizeMemo(data);
  },

  async listMemoComments(req: any) {
    const id = extractId(req.name, "memos/");
    const params: Record<string, unknown> = {};
    if (req.pageSize) params.pageSize = req.pageSize;
    if (req.pageToken) params.pageToken = req.pageToken;
    if (req.orderBy) params.orderBy = req.orderBy;
    const data = await apiRequest<any>("GET", `/api/v1/memos/${id}/comments${buildQueryString(params)}`);
    return {
      memos: (data.memos || []).map(normalizeMemo),
      nextPageToken: data.nextPageToken || "",
      totalSize: data.totalSize || 0,
    };
  },

  async listMemoReactions(req: any) {
    const id = extractId(req.name, "memos/");
    const data = await apiRequest<any>("GET", `/api/v1/memos/${id}/reactions`);
    return { reactions: normalizeReactions(data.reactions || []), nextPageToken: "", totalSize: 0 };
  },

  async upsertMemoReaction(req: { name: string; reaction: any }) {
    const id = extractId(req.name, "memos/");
    const data = await apiRequest<any>("POST", `/api/v1/memos/${id}/reactions`, {
      reactionType: req.reaction?.reactionType || "",
    });
    return normalizeReaction(data);
  },

  async deleteMemoReaction(req: { name: string }) {
    const parts = req.name.split("/");
    const memoId = parts[1];
    const reactionId = parts[3];
    await apiRequest<any>("DELETE", `/api/v1/memos/${memoId}/reactions/${reactionId}`);
  },

  async createMemoShare(req: { parent: string; memoShare?: any }) {
    const id = extractId(req.parent, "memos/");
    const body: any = {};
    if (req.memoShare?.expireTime) body.expireTime = timestampToISO(req.memoShare.expireTime);
    const data = await apiRequest<any>("POST", `/api/v1/memos/${id}/shares`, body);
    return normalizeShare(data);
  },

  async listMemoShares(req: { parent: string }) {
    const id = extractId(req.parent, "memos/");
    const data = await apiRequest<any>("GET", `/api/v1/memos/${id}/shares`);
    return { memoShares: (data.memoShares || []).map(normalizeShare) };
  },

  async deleteMemoShare(req: { name: string }) {
    const parts = req.name.split("/");
    const memoId = parts[1];
    const shareId = parts[3];
    await apiRequest<any>("DELETE", `/api/v1/memos/${memoId}/shares/${shareId}`);
  },

  async getMemoByShare(req: { shareId: string }) {
    const data = await apiRequest<any>("GET", `/api/v1/shares/${req.shareId}`);
    return normalizeMemo(data);
  },

  async getLinkMetadata(req: { url: string }) {
    const data = await apiRequest<any>("GET", `/api/v1/memos/-/linkMetadata${buildQueryString({ url: req.url })}`);
    return data;
  },

  async batchGetLinkMetadata(req: { urls: string[] }) {
    const data = await apiRequest<any>("POST", "/api/v1/memos/-/linkMetadata:batchGet", { urls: req.urls });
    return { linkMetadata: data.linkMetadata || [] };
  },
};

// ============================================================================
// Auth Service Client
// ============================================================================

export const authServiceClient = {
  async getCurrentUser(_req?: any) {
    const data = await apiRequest<any>("GET", "/api/v1/auth/me");
    return { user: normalizeUser(data.user ?? data) };
  },

  async signIn(req: { username?: string; password?: string; credentials?: any; neverExpire?: boolean }) {
    let body: any;

    if (req.credentials?.case === "ssoCredentials") {
      body = { ssoCredentials: req.credentials.value };
    } else {
      let username = req.username;
      let password = req.password;
      if (req.credentials?.value) {
        username = req.credentials.value.username;
        password = req.credentials.value.password;
      }
      body = { passwordCredentials: { username, password } };
    }

    const data = await apiRequest<any>("POST", "/api/v1/auth/signin", body);
    return {
      accessToken: data.accessToken,
      accessTokenExpiresAt: data.accessTokenExpiresAt ? isoToTimestamp(data.accessTokenExpiresAt) : undefined,
      user: data.user ? normalizeUser(data.user) : undefined,
    };
  },

  async signOut(_req?: any) {
    await apiRequest<any>("POST", "/api/v1/auth/signout");
  },

  async refreshToken(_req?: any) {
    const data = await apiRequest<any>("POST", "/api/v1/auth/refresh");
    return {
      accessToken: data.accessToken,
      expiresAt: data.expiresAt ? isoToTimestamp(data.expiresAt) : undefined,
    };
  },

  async signUp(req: { username: string; password: string }) {
    const data = await apiRequest<any>("POST", "/api/v1/auth/signup", {
      username: req.username,
      password: req.password,
    });
    return {
      accessToken: data.accessToken,
      accessTokenExpiresAt: data.accessTokenExpiresAt ? isoToTimestamp(data.accessTokenExpiresAt) : undefined,
      user: data.user ? normalizeUser(data.user) : undefined,
    };
  },
};

// ============================================================================
// User Service Client
// ============================================================================

export const userServiceClient = {
  async listUsers(_req?: any) {
    const data = await apiRequest<any>("GET", "/api/v1/users");
    return { users: (data.users || []).map(normalizeUser) };
  },

  async batchGetUsers(req: { usernames: string[] }) {
    const data = await apiRequest<any>("POST", "/api/v1/users:batchGet", { usernames: req.usernames });
    return { users: (data.users || []).map(normalizeUser) };
  },

  async getUser(req: { name: string }) {
    const username = extractId(req.name, "users/");
    const data = await apiRequest<any>("GET", `/api/v1/users/${username}`);
    return normalizeUser(data);
  },

  async createUser(req: { user: any }) {
    const data = await apiRequest<any>("POST", "/api/v1/users", buildUserPayload(req.user));
    return normalizeUser(data);
  },

  async updateUser(req: { user: any; updateMask?: any }) {
    const user = req.user || {};
    const username = extractId(user.name, "users/");
    const data = await apiRequest<any>("PATCH", `/api/v1/users/${username}`, buildUserPayload(user));
    return normalizeUser(data);
  },

  async deleteUser(req: { name: string }) {
    const username = extractId(req.name, "users/");
    await apiRequest<any>("DELETE", `/api/v1/users/${username}`);
  },

  async getUserStats(req: { name: string }) {
    const username = extractId(req.name, "users/");
    return apiRequest<any>("GET", `/api/v1/users/${username}:getStats`);
  },

  async listAllUserStats(_req?: any) {
    const data = await apiRequest<any>("GET", "/api/v1/users:stats");
    return { stats: data.stats || [] };
  },

  async getUserSetting(req: { name: string }) {
    const parts = req.name.split("/");
    const username = parts[1];
    const key = parts[3];
    const data = await apiRequest<any>("GET", `/api/v1/users/${username}/settings/${key}`);
    return normalizeUserSetting(data, req.name);
  },

  async updateUserSetting(req: { setting: any; updateMask?: any }) {
    const setting = req.setting || {};
    const parts = (setting.name || "").split("/");
    const username = parts[1];
    const key = parts[3] || setting.key;
    const caseName = setting.value?.case;
    const innerValue = setting.value?.value !== undefined ? setting.value.value : {};
    const body: any = { name: setting.name };
    if (caseName) {
      body[caseName] = innerValue;
    } else {
      body.value = innerValue;
    }
    const data = await apiRequest<any>("PATCH", `/api/v1/users/${username}/settings/${key}`, body);
    return normalizeUserSetting(data, setting.name);
  },

  async listUserSettings(req: { parent: string }) {
    const username = extractId(req.parent, "users/");
    const data = await apiRequest<any>("GET", `/api/v1/users/${username}/settings`);
    const settings = (data.settings || []).map((s: any) =>
      normalizeUserSetting(s, `users/${username}/settings/${s.key ?? ""}`),
    );
    return { settings };
  },

  async listPersonalAccessTokens(req: { parent: string }) {
    const username = extractId(req.parent, "users/");
    const data = await apiRequest<any>("GET", `/api/v1/users/${username}/personalAccessTokens`);
    const tokens = (data.personalAccessTokens || []).map((t: any) => ({
      ...t,
      name: t.name || `users/${username}/personalAccessTokens/${t.hash}`,
      createdAt: t.createdAt ? isoToTimestamp(t.createdAt) : undefined,
      expiresAt: t.expiresAt ? isoToTimestamp(t.expiresAt) : undefined,
    }));
    return { personalAccessTokens: tokens };
  },

  async createPersonalAccessToken(req: { parent: string; personalAccessToken?: any; description?: string; expiresInDays?: number }) {
    const username = extractId(req.parent, "users/");
    const body = req.personalAccessToken || { description: req.description, expiresInDays: req.expiresInDays };
    const data = await apiRequest<any>("POST", `/api/v1/users/${username}/personalAccessTokens`, body);
    const token = data.personalAccessToken;
    return {
      token: data.token,
      personalAccessToken: {
        ...(token || {}),
        description: token?.description || body.description || "",
        createdAt: token?.createdAt ? isoToTimestamp(token.createdAt) : undefined,
        expiresAt: token?.expiresAt ? isoToTimestamp(token.expiresAt) : undefined,
      },
    };
  },

  async deletePersonalAccessToken(req: { name: string }) {
    const parts = req.name.split("/");
    const username = parts[1];
    const tokenId = parts[3];
    await apiRequest<any>("DELETE", `/api/v1/users/${username}/personalAccessTokens/${tokenId}`);
  },

  async listUserNotifications(req: { parent: string }) {
    const username = extractId(req.parent, "users/");
    const data = await apiRequest<any>("GET", `/api/v1/users/${username}/notifications`);
    const notifications = (data.notifications || []).map(normalizeUserNotification);
    return { notifications, nextPageToken: data.nextPageToken || "" };
  },

  async updateUserNotification(req: { notification: any; updateMask?: any }) {
    const notif = req.notification || {};
    const parts = (notif.name || "").split("/");
    const username = parts[1];
    const notifId = parts[3];
    const status = typeof notif.status === "number" ? (notif.status === 2 ? "ARCHIVED" : "UNREAD") : notif.status;
    const data = await apiRequest<any>("PATCH", `/api/v1/users/${username}/notifications/${notifId}`, {
      name: notif.name,
      status,
    });
    return normalizeUserNotification(data);
  },

  async deleteUserNotification(req: { name: string }) {
    const parts = req.name.split("/");
    const username = parts[1];
    const notifId = parts[3];
    await apiRequest<any>("DELETE", `/api/v1/users/${username}/notifications/${notifId}`);
  },

  async listUserWebhooks(req: { parent: string }) {
    const username = extractId(req.parent, "users/");
    const data = await apiRequest<any>("GET", `/api/v1/users/${username}/webhooks`);
    return { webhooks: data.webhooks || [] };
  },

  async createUserWebhook(req: { parent: string; webhook: any }) {
    const username = extractId(req.parent, "users/");
    return apiRequest<any>("POST", `/api/v1/users/${username}/webhooks`, req.webhook);
  },

  async updateUserWebhook(req: { webhook: any; updateMask?: any }) {
    const webhook = req.webhook || {};
    const parts = (webhook.name || "").split("/");
    const username = parts[1];
    const webhookId = parts[3];
    return apiRequest<any>("PATCH", `/api/v1/users/${username}/webhooks/${webhookId}`, webhook);
  },

  async deleteUserWebhook(req: { name: string }) {
    const parts = req.name.split("/");
    const username = parts[1];
    const webhookId = parts[3];
    await apiRequest<any>("DELETE", `/api/v1/users/${username}/webhooks/${webhookId}`);
  },

  async listShortcuts(_req?: any) {
    return apiRequest<any>("GET", "/api/v1/shortcuts");
  },

  async listLinkedIdentities(req: { parent: string }) {
    const username = extractId(req.parent, "users/");
    const data = await apiRequest<any>("GET", `/api/v1/users/${username}/linkedIdentities`).catch(() => ({ linkedIdentities: [] }));
    return { linkedIdentities: (data.linkedIdentities || []).map(normalizeLinkedIdentity) };
  },

  async createLinkedIdentity(req: { parent: string; idpName?: string; code?: string; redirectUri?: string; codeVerifier?: string }) {
    const username = extractId(req.parent, "users/");
    return apiRequest<any>("POST", `/api/v1/users/${username}/linkedIdentities`, {
      idpName: req.idpName,
      code: req.code,
      redirectUri: req.redirectUri,
      codeVerifier: req.codeVerifier,
    });
  },

  async deleteLinkedIdentity(req: { name: string }) {
    const parts = req.name.split("/");
    const username = parts[1];
    const identityId = parts[3];
    await apiRequest<any>("DELETE", `/api/v1/users/${username}/linkedIdentities/${identityId}`);
  },
};

// ============================================================================
// Attachment Service Client
// ============================================================================

export const attachmentServiceClient = {
  async createAttachment(req: { attachment: any }) {
    const att = req.attachment || {};
    const formData = new FormData();

    if (att.content instanceof Uint8Array) {
      const blob = new Blob([att.content], { type: att.type || "application/octet-stream" });
      formData.append("file", blob, att.filename || "unnamed");
    } else if (att.file instanceof File) {
      formData.append("file", att.file);
    }

    const data = await apiRequest<any>("POST", "/api/v1/attachments", formData, { isFormData: true });
    return normalizeAttachment(data);
  },

  async listAttachments(req?: any) {
    const params: Record<string, unknown> = {};
    if (req?.pageSize) params.pageSize = req.pageSize;
    if (req?.pageToken) params.pageToken = req.pageToken;
    if (req?.filter) params.filter = req.filter;
    if (req?.orderBy) params.orderBy = req.orderBy;
    const data = await apiRequest<any>("GET", `/api/v1/attachments${buildQueryString(params)}`);
    return {
      attachments: (data.attachments || []).map(normalizeAttachment),
      nextPageToken: data.nextPageToken || "",
      totalSize: data.totalSize || 0,
    };
  },

  async getAttachment(req: { name: string }) {
    const id = extractId(req.name, "attachments/");
    const data = await apiRequest<any>("GET", `/api/v1/attachments/${id}`);
    return normalizeAttachment(data);
  },

  async updateAttachment(req: { attachment: any; updateMask?: any }) {
    const att = req.attachment || {};
    const id = extractId(att.name, "attachments/");
    const data = await apiRequest<any>("PATCH", `/api/v1/attachments/${id}`, att);
    return normalizeAttachment(data);
  },

  async deleteAttachment(req: { name: string }) {
    const id = extractId(req.name, "attachments/");
    await apiRequest<any>("DELETE", `/api/v1/attachments/${id}`);
  },

  async batchDeleteAttachments(req: { names: string[] }) {
    await apiRequest<any>("POST", "/api/v1/attachments:batchDelete", { names: req.names || [] });
  },
};

// ============================================================================
// Instance Service Client
// ============================================================================

export const instanceServiceClient = {
  async getInstanceProfile(_req?: any) {
    return apiRequest<any>("GET", "/api/v1/instance/profile");
  },

  async getInstanceUploadConfig() {
    return apiRequest<any>("GET", "/api/v1/instance/upload-config");
  },

  async getInstanceSetting(req: { name: string }) {
    const name = req.name; // e.g. "instance/settings/GENERAL"
    const data = await apiRequest<any>("GET", `/api/v1/${name}`);
    return normalizeInstanceSetting(data, name);
  },

  async updateInstanceSetting(req: { setting: any; updateMask?: any }) {
    const setting = req.setting || {};
    const name = setting.name; // e.g. "instance/settings/GENERAL"
    const caseName = setting.value?.case;
    const innerValue = setting.value?.value ?? {};
    const body: any = { name };
    if (caseName) {
      body[caseName] = innerValue;
    } else {
      body.value = innerValue;
    }
    const data = await apiRequest<any>("PATCH", `/api/v1/${name}`, body);
    return normalizeInstanceSetting(data, name);
  },

  async listInstanceSettings(req?: { names?: string[] }) {
    const data = await apiRequest<any>("POST", "/api/v1/instance/settings:batchGet", { names: req?.names || [] });
    return { settings: (data.settings || []).map((s: any) => normalizeInstanceSetting(s, s.name)) };
  },

  async getInstanceStats(_req?: any) {
    const data = await apiRequest<any>("GET", "/api/v1/instance/stats").catch(() => ({}));
    if (!data || !data.database) return data;
    return {
      database: {
        driver: data.database.driver || "",
        sizeBytes: toBigInt(data.database.sizeBytes),
      },
      localStorageBytes: toBigInt(data.localStorageBytes),
      generatedTime: data.generatedTime ? isoToTimestamp(data.generatedTime) : undefined,
    };
  },

  async testInstanceEmailSetting(req: { email?: any; recipientEmail?: string }) {
    return apiRequest<any>("POST", "/api/v1/instance/settings/notification:testEmail", req);
  },
};

// ============================================================================
// AI Service Client (stub)
// ============================================================================

export const aiServiceClient = {
  async transcribeAudio(_req: any) {
    return { text: "" };
  },

  async transcribe(req: any) {
    const audio = req.audio;
    if (!audio) return { text: "" };

    const body: any = { audio: {} };
    if (audio.source?.case === "content" && audio.source.value) {
      body.audio.content = bytesToBase64(audio.source.value);
    }
    if (audio.filename) body.audio.filename = audio.filename;
    if (audio.contentType) body.audio.contentType = audio.contentType;
    if (req.language) body.language = req.language;

    const data = await apiRequest<any>("POST", "/api/v1/ai:transcribe", body);
    return { text: data.text || "" };
  },
};

// ============================================================================
// Shortcut Service Client
// ============================================================================

export const shortcutServiceClient = {
  async listShortcuts(req?: { parent?: string }) {
    const username = extractId(req?.parent || "", "users/");
    if (!username) return { shortcuts: [] };
    const data = await apiRequest<any>("GET", `/api/v1/users/${username}/shortcuts`).catch(() => ({ shortcuts: [] }));
    return { shortcuts: (data.shortcuts || []).map(normalizeShortcut) };
  },

  async createShortcut(req: { shortcut: any; parent?: string }) {
    const username = extractId(req.parent || "", "users/");
    const shortcut = req.shortcut || {};
    const data = await apiRequest<any>("POST", `/api/v1/users/${username}/shortcuts`, {
      title: shortcut.title || "",
      filter: shortcut.filter || "",
    });
    return normalizeShortcut(data);
  },

  async updateShortcut(req: { shortcut: any; updateMask?: any }) {
    const shortcut = req.shortcut || {};
    const parts = (shortcut.name || "").split("/");
    const username = parts[1];
    const id = parts[3];
    const data = await apiRequest<any>("PATCH", `/api/v1/users/${username}/shortcuts/${id}`, {
      name: shortcut.name,
      title: shortcut.title,
      filter: shortcut.filter,
    });
    return normalizeShortcut(data);
  },

  async deleteShortcut(req: { name: string }) {
    const parts = req.name.split("/");
    const username = parts[1];
    const id = parts[3];
    await apiRequest<any>("DELETE", `/api/v1/users/${username}/shortcuts/${id}`);
  },
};

// ============================================================================
// Identity Provider Service Client
// ============================================================================

export const identityProviderServiceClient = {
  async listIdentityProviders(_req?: any) {
    const data = await apiRequest<any>("GET", "/api/v1/identity-providers").catch(() => ({ identityProviders: [] }));
    return { identityProviders: (data.identityProviders || []).map(normalizeIdentityProvider) };
  },

  async createIdentityProvider(req: { identityProvider: any; identityProviderId?: string }) {
    const query = req.identityProviderId ? buildQueryString({ identityProviderId: req.identityProviderId }) : "";
    const data = await apiRequest<any>(
      "POST",
      `/api/v1/identity-providers${query}`,
      buildIdentityProviderPayload(req.identityProvider),
    );
    return normalizeIdentityProvider(data);
  },

  async updateIdentityProvider(req: { identityProvider: any; updateMask?: any }) {
    const idp = req.identityProvider || {};
    const id = extractIdentityProviderUid(idp.name || "");
    const data = await apiRequest<any>("PATCH", `/api/v1/identity-providers/${id}`, buildIdentityProviderPayload(idp));
    return normalizeIdentityProvider(data);
  },

  async deleteIdentityProvider(req: { name: string }) {
    const id = extractIdentityProviderUid(req.name);
    await apiRequest<any>("DELETE", `/api/v1/identity-providers/${id}`);
  },
};

// ============================================================================
// Helpers
// ============================================================================

function extractId(name: string, prefix: string): string {
  if (name.startsWith(prefix)) return name.slice(prefix.length);
  const index = name.lastIndexOf(`/${prefix}`);
  if (index >= 0) return name.slice(index + prefix.length + 1);
  return name;
}

function visibilityToString(v: any): string {
  if (typeof v === "string") return v;
  switch (v) {
    case 1: return "PRIVATE";
    case 2: return "PROTECTED";
    case 3: return "PUBLIC";
    default: return "PRIVATE";
  }
}

function stateToString(s: any): string {
  if (typeof s === "string") return s;
  switch (s) {
    case 1: return "NORMAL";
    case 2: return "ARCHIVED";
    default: return "NORMAL";
  }
}

function stringToVisibility(s: string): number {
  switch (s) {
    case "PRIVATE": return 1;
    case "PROTECTED": return 2;
    case "PUBLIC": return 3;
    default: return 1;
  }
}

function timestampToISO(ts: any): string {
  if (!ts) return "";
  if (typeof ts === "string") return ts;
  if (ts.seconds) {
    const s = typeof ts.seconds === "bigint" ? Number(ts.seconds) : Number(ts.seconds);
    return new Date(s * 1000).toISOString();
  }
  return "";
}

function isoToTimestamp(iso: string | undefined): any {
  if (!iso) return undefined;
  const seconds = Math.floor(new Date(iso).getTime() / 1000);
  return { seconds, nanos: 0 };
}

function toBigInt(value: any): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string" && value.trim() !== "") {
    try {
      return BigInt(value);
    } catch {
      return BigInt(0);
    }
  }
  return BigInt(0);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function normalizeMemo(data: any): any {
  if (!data) return data;
  const state = data.state ?? data.rowStatus;
  return {
    ...data,
    name: data.name || `memos/${data.id || data.uid}`,
    state: state === "ARCHIVED" || state === 2 ? 2 : 1,
    creator: data.creator || `users/${data.creatorId}`,
    createTime: isoToTimestamp(data.createTime),
    updateTime: isoToTimestamp(data.updateTime),
    visibility: stringToVisibility(data.visibility),
    pinned: data.pinned ?? false,
    content: data.content ?? "",
    tags: data.tags || [],
    attachments: (data.attachments || []).map(normalizeAttachment),
    relations: (data.relations || []).map(normalizeRelation),
    reactions: normalizeReactions(data.reactions || []),
    property: data.property || {},
    parent: data.parent || "",
    snippet: data.snippet || "",
    location: data.location || undefined,
  };
}

function normalizeUser(data: any): any {
  if (!data) return data;
  const rawState = data.state ?? data.rowStatus;
  return {
    ...data,
    name: data.name || `users/${data.username}`,
    displayName: data.displayName ?? data.nickname ?? "",
    state: rawState === "ARCHIVED" || rawState === 2 ? 2 : 1,
    createTime: isoToTimestamp(data.createTime),
    updateTime: isoToTimestamp(data.updateTime),
    role: typeof data.role === "string" ? (data.role === "ADMIN" ? 2 : 1) : data.role,
  };
}

function buildUserPayload(user: any): any {
  const input = user || {};
  const body: any = {};
  for (const key of ["username", "email", "avatarUrl", "description", "nickname", "displayName", "password"]) {
    if (input[key] !== undefined) body[key] = input[key];
  }
  if (input.role !== undefined && input.role !== 0 && input.role !== "") {
    body.role = typeof input.role === "number" ? (input.role === 2 ? "ADMIN" : "USER") : String(input.role).toUpperCase();
  }
  if (input.state !== undefined && input.state !== 0 && input.state !== "") {
    body.state = typeof input.state === "number" ? (input.state === 2 ? "ARCHIVED" : "NORMAL") : String(input.state).toUpperCase();
  }
  return body;
}

function normalizeAttachment(data: any): any {
  if (!data) return data;
  const memoName =
    data.memo ||
    (data.memoId !== undefined && data.memoId !== null ? `memos/${data.memoId}` : data.memo_id !== undefined && data.memo_id !== null ? `memos/${data.memo_id}` : undefined);
  return {
    ...data,
    name: data.name || `attachments/${data.id || data.uid}`,
    createTime: isoToTimestamp(data.createTime || data.created_ts),
    size: toBigInt(data.size),
    memo: memoName,
    externalLink: data.externalLink || data.external_link || "",
    motionMedia: data.motionMedia || data.motion_media,
  };
}

function normalizeRelation(data: any): any {
  if (!data) return data;
  return {
    ...data,
    memo: data.memo || (data.memo_id ? { name: `memos/${data.memo_id}`, snippet: "" } : undefined),
    relatedMemo:
      data.relatedMemo || (data.related_memo_id ? { name: `memos/${data.related_memo_id}`, snippet: "" } : undefined),
    type: typeof data.type === "string" ? (data.type === "COMMENT" ? 2 : 1) : data.type,
  };
}

function normalizeReactions(reactions: any[]): any[] {
  return reactions.map(normalizeReaction);
}

function normalizeReaction(r: any): any {
  return {
    ...r,
    createTime: isoToTimestamp(r.createTime || r.created_ts),
  };
}

function normalizeShare(s: any): any {
  if (!s) return s;
  return {
    ...s,
    name: s.name || `memos/${s.memo_id}/shares/${s.uid}`,
    createTime: s.createTime ? isoToTimestamp(s.createTime) : s.created_ts ? { seconds: s.created_ts, nanos: 0 } : undefined,
    expireTime: s.expireTime ? isoToTimestamp(s.expireTime) : s.expires_ts ? { seconds: s.expires_ts, nanos: 0 } : undefined,
  };
}

function normalizeShortcut(data: any): any {
  if (!data) return data;
  return {
    ...data,
    title: data.title || "",
    filter: data.filter || "",
  };
}

function normalizeUserSetting(data: any, fallbackName: string): any {
  if (!data) {
    return { name: fallbackName, value: { case: undefined, value: undefined } };
  }
  if (data.generalSetting !== undefined) {
    return { name: data.name || fallbackName, value: { case: "generalSetting", value: data.generalSetting || {} } };
  }
  if (data.webhooksSetting !== undefined) {
    return {
      name: data.name || fallbackName,
      value: {
        case: "webhooksSetting",
        value: {
          ...data.webhooksSetting,
          webhooks: (data.webhooksSetting?.webhooks || []).map(normalizeUserWebhook),
        },
      },
    };
  }
  // Legacy shape: { key, value: JSON string }
  if (data.key !== undefined) {
    const normalizedKey = String(data.key).toUpperCase();
    let parsedValue: any = data.value;
    if (typeof parsedValue === "string") {
      try {
        parsedValue = JSON.parse(parsedValue);
      } catch {
        parsedValue = {};
      }
    }
    const caseName = normalizedKey === "WEBHOOKS" ? "webhooksSetting" : "generalSetting";
    const value =
      caseName === "webhooksSetting"
        ? { webhooks: (parsedValue?.webhooks || []).map(normalizeUserWebhook) }
        : parsedValue || {};
    return { name: data.name || fallbackName, value: { case: caseName, value } };
  }
  return { name: data.name || fallbackName, value: data.value || { case: undefined, value: undefined } };
}

function normalizeUserWebhook(data: any): any {
  if (!data) return data;
  return {
    ...data,
    createTime: isoToTimestamp(data.createTime),
    updateTime: isoToTimestamp(data.updateTime),
  };
}

function normalizeUserNotification(data: any): any {
  if (!data) return data;
  const statusMap: Record<string, number> = { UNREAD: 1, ARCHIVED: 2 };
  const typeMap: Record<string, number> = { MEMO_COMMENT: 1, MEMO_MENTION: 2 };
  let payload: any = { case: undefined, value: undefined };
  if (data.memoComment) {
    payload = { case: "memoComment", value: data.memoComment };
  } else if (data.memoMention) {
    payload = { case: "memoMention", value: data.memoMention };
  } else if (data.payload?.case) {
    payload = data.payload;
  }
  return {
    ...data,
    status: typeof data.status === "string" ? statusMap[data.status] ?? 0 : data.status,
    type: typeof data.type === "string" ? typeMap[data.type] ?? 0 : data.type,
    createTime: isoToTimestamp(data.createTime),
    senderUser: data.senderUser ? normalizeUser(data.senderUser) : undefined,
    payload,
  };
}

function normalizeInstanceSetting(data: any, fallbackName: string): any {
  if (!data) {
    return { name: fallbackName, value: { case: undefined, value: undefined } };
  }
  const caseMap: Record<string, string> = {
    generalSetting: "generalSetting",
    storageSetting: "storageSetting",
    memoRelatedSetting: "memoRelatedSetting",
    tagsSetting: "tagsSetting",
    notificationSetting: "notificationSetting",
    aiSetting: "aiSetting",
  };
  for (const caseName of Object.keys(caseMap)) {
    if (data[caseName] !== undefined) {
      return { name: data.name || fallbackName, value: { case: caseName, value: data[caseName] || {} } };
    }
  }
  // Legacy shape: { key, value: JSON string }
  if (data.value !== undefined) {
    let parsedValue: any = data.value;
    if (typeof parsedValue === "string") {
      try {
        parsedValue = JSON.parse(parsedValue);
      } catch {
        parsedValue = {};
      }
    }
    const keyName = (data.name || fallbackName).split("/").pop() || "";
    const legacyMap: Record<string, string> = {
      GENERAL: "generalSetting",
      MEMO_RELATED: "memoRelatedSetting",
      STORAGE: "storageSetting",
      TAGS: "tagsSetting",
      NOTIFICATION: "notificationSetting",
      AI: "aiSetting",
    };
    return { name: data.name || fallbackName, value: { case: legacyMap[keyName] || "generalSetting", value: parsedValue || {} } };
  }
  return { name: data.name || fallbackName, value: { case: undefined, value: undefined } };
}

const IDENTITY_PROVIDER_NAME_PREFIX = "identity-providers/";
const LEGACY_IDENTITY_PROVIDER_NAME_PREFIX = "identityProviders/";

function buildIdentityProviderPayload(identityProvider: any): any {
  const config = normalizeOAuth2Config(identityProvider?.config);
  const payload: any = {
    title: identityProvider?.title || "",
    type: "OAUTH2",
    identifierFilter: identityProvider?.identifierFilter ?? identityProvider?.identifier_filter ?? "",
  };
  if (config) {
    payload.config = { oauth2Config: config };
  }
  return payload;
}

function normalizeIdentityProvider(data: any): any {
  if (!data) return data;

  const uid = data.uid || extractIdentityProviderUid(data.name || "");
  const rawName = typeof data.name === "string" ? data.name : "";
  const hasResourceName = rawName.startsWith(IDENTITY_PROVIDER_NAME_PREFIX) || rawName.startsWith(LEGACY_IDENTITY_PROVIDER_NAME_PREFIX);
  const oauth2Config = normalizeOAuth2Config(data.config);
  const title =
    typeof data.title === "string" && data.title.trim() ? data.title : !hasResourceName && rawName.trim() ? rawName : uid || "OAuth2";

  return {
    ...data,
    name: normalizeIdentityProviderName(rawName, uid),
    title,
    type: normalizeIdentityProviderType(data.type),
    identifierFilter: data.identifierFilter ?? data.identifier_filter ?? "",
    config: wrapIdentityProviderConfig(oauth2Config),
  };
}

function normalizeLinkedIdentity(data: any): any {
  if (!data) return data;
  return {
    ...data,
    idpName: normalizeIdentityProviderName(data.idpName || ""),
  };
}

function normalizeIdentityProviderName(name: string, fallbackUid = ""): string {
  const uid = isIdentityProviderResourceName(name) ? extractIdentityProviderUid(name) : fallbackUid || name;
  return uid ? `${IDENTITY_PROVIDER_NAME_PREFIX}${uid}` : "";
}

function extractIdentityProviderUid(name: string): string {
  if (!name) return "";
  if (name.startsWith(IDENTITY_PROVIDER_NAME_PREFIX)) return name.slice(IDENTITY_PROVIDER_NAME_PREFIX.length);
  if (name.startsWith(LEGACY_IDENTITY_PROVIDER_NAME_PREFIX)) return name.slice(LEGACY_IDENTITY_PROVIDER_NAME_PREFIX.length);
  return name;
}

function isIdentityProviderResourceName(name: string): boolean {
  return name.startsWith(IDENTITY_PROVIDER_NAME_PREFIX) || name.startsWith(LEGACY_IDENTITY_PROVIDER_NAME_PREFIX);
}

function normalizeIdentityProviderType(value: any): number {
  if (typeof value === "number") {
    return value;
  }
  return typeof value === "string" && value.toLowerCase() === "oauth2" ? 1 : 0;
}

function normalizeOAuth2Config(value: any): any | undefined {
  const raw = unwrapOAuth2Config(value);
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const fieldMapping = raw.fieldMapping ?? raw.field_mapping ?? {};
  const config = {
    clientId: typeof raw.clientId === "string" ? raw.clientId : typeof raw.client_id === "string" ? raw.client_id : "",
    clientSecret: typeof raw.clientSecret === "string" ? raw.clientSecret : typeof raw.client_secret === "string" ? raw.client_secret : "",
    authUrl: typeof raw.authUrl === "string" ? raw.authUrl : typeof raw.auth_url === "string" ? raw.auth_url : "",
    tokenUrl: typeof raw.tokenUrl === "string" ? raw.tokenUrl : typeof raw.token_url === "string" ? raw.token_url : "",
    userInfoUrl: typeof raw.userInfoUrl === "string" ? raw.userInfoUrl : typeof raw.user_info_url === "string" ? raw.user_info_url : "",
    scopes: Array.isArray(raw.scopes) ? raw.scopes.map((scope: unknown) => String(scope)).filter(Boolean) : [],
    fieldMapping: {
      identifier: typeof fieldMapping.identifier === "string" ? fieldMapping.identifier : "",
      displayName:
        typeof fieldMapping.displayName === "string"
          ? fieldMapping.displayName
          : typeof fieldMapping.display_name === "string"
            ? fieldMapping.display_name
            : "",
      email: typeof fieldMapping.email === "string" ? fieldMapping.email : "",
      avatarUrl:
        typeof fieldMapping.avatarUrl === "string"
          ? fieldMapping.avatarUrl
          : typeof fieldMapping.avatar_url === "string"
            ? fieldMapping.avatar_url
            : "",
    },
  };

  return hasOAuth2Config(config) ? config : undefined;
}

function wrapIdentityProviderConfig(config: any): any {
  if (!config) {
    return {
      config: {
        case: undefined,
        value: undefined,
      },
    };
  }

  return {
    config: {
      case: "oauth2Config",
      value: config,
    },
  };
}

function hasOAuth2Config(config: any): boolean {
  return Boolean(
    config.clientId ||
      config.clientSecret ||
      config.authUrl ||
      config.tokenUrl ||
      config.userInfoUrl ||
      config.scopes.length > 0 ||
      config.fieldMapping.identifier ||
      config.fieldMapping.displayName ||
      config.fieldMapping.email ||
      config.fieldMapping.avatarUrl,
  );
}

function unwrapOAuth2Config(value: any): any {
  const parsed = parsePossiblyJson(value);
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }

  if (parsed.config && typeof parsed.config === "object" && parsed.config.oauth2Config && typeof parsed.config.oauth2Config === "object") {
    return parsed.config.oauth2Config;
  }

  if (parsed.config && typeof parsed.config === "object" && parsed.config.case === "oauth2Config" && parsed.config.value) {
    return parsed.config.value;
  }

  if (parsed.case === "oauth2Config" && parsed.value) {
    return parsed.value;
  }

  return parsed;
}

function parsePossiblyJson(value: any): any {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
