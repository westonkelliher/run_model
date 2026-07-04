export default async function wordCount(input: { text: string }): Promise<string> {
  const count = input.text.trim().split(/\s+/).filter(Boolean).length;
  return String(count);
}
