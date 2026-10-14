export function canManageRole(actorRole, targetRole) {
  if (targetRole === "developer") return false;
  if (actorRole === "developer") return targetRole === "admin";
  if (actorRole === "admin") return ["admin", "teacher", "student"].includes(targetRole);
  if (actorRole === "teacher") return targetRole === "student";
  return false;
}

export function rolesVisibleTo(actorRole) {
  if (actorRole === "developer") return ["admin"];
  if (actorRole === "admin") return ["admin", "teacher", "student"];
  if (actorRole === "teacher") return ["student"];
  return null;
}

export function canManageContent(actorRole, authorId, actorId) {
  return ["developer", "admin"].includes(actorRole) ||
    (actorRole === "teacher" && String(authorId) === String(actorId));
}
