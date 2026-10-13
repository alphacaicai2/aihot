type ImageShareNavigator = Partial<Pick<Navigator, "canShare" | "share">>;

export function canShareImage(file: File, target: ImageShareNavigator): boolean {
  try {
    return typeof target.share === "function" && target.canShare?.({ files: [file] }) === true;
  } catch {
    return false;
  }
}

export async function shareImage(file: File, target: ImageShareNavigator): Promise<"shared" | "cancelled" | "unsupported" | "failed"> {
  if (!canShareImage(file, target)) return "unsupported";
  try {
    // Invoke directly from the click, before any await, to preserve user activation.
    await target.share!({ files: [file] });
    return "shared";
  } catch (error) {
    return error instanceof Error && error.name === "AbortError" ? "cancelled" : "failed";
  }
}
