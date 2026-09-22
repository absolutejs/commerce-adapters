export const storeUrlIsSafe = (value: string) => {
  const url = value.trim();
  if (url.startsWith("/") && !url.startsWith("//")) return true;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
};
