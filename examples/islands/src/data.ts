export interface Reply {
  user: string;
  text: string;
  replies: Reply[];
}

export const thread: Reply[] = [
  {
    user: "ada",
    text: "Inert regions ship no code at all.",
    replies: [
      {
        user: "grace",
        text: "And the toggles?",
        replies: [{ user: "ada", text: "Tier 0: no runtime.", replies: [] }]
      },
      { user: "alan", text: "Each one activates alone, on its first click.", replies: [] }
    ]
  },
  { user: "edsger", text: "The counter is an island cut from the page component.", replies: [] }
];
