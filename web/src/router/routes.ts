export const ROUTES = {
  // Entry-only route. Hosts the landing redirect, never a business page.
  ENTRY: "/",
  // The authenticated user's primary workspace page.
  HOME: "/home",
  ATTACHMENTS: "/attachments",
  INBOX: "/inbox",
  ARCHIVED: "/archived",
  CALENDAR: "/calendar",
  MAP: "/map",
  VIEWS: "/views",
  SPACES: "/spaces",
  SETTING: "/setting",
  EXPLORE: "/explore",
  AUTH: "/auth",
  SHARED_MEMO: "/memos/shares",
} as const;

export const CALENDAR_ROUTE_PATTERN = `${ROUTES.CALENDAR}/:year?/:month?/:day?`;
export const SPACE_ROUTE_PATTERN = `${ROUTES.SPACES}/:spaceUid`;

export type RouteKey = keyof typeof ROUTES;
export type RoutePath = (typeof ROUTES)[RouteKey];
