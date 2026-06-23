import { Component, createMemo, Show } from "solid-js"
import { useSync } from "@/context/sync"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { useLanguage } from "@/context/language"

export const DialogSkills: Component = () => {
  const sync = useSync()
  const language = useLanguage()

  const skills = createMemo(() =>
    sync.data.command
      .filter((cmd) => cmd.source === "skill")
      .sort((a, b) => a.name.localeCompare(b.name)),
  )

  const count = createMemo(() => skills().length)

  return (
    <Dialog
      title="Skills"
      description={`${count()} ${count() === 1 ? "skill" : "skills"}`}
    >
      <List
        class="px-3"
        search={{ placeholder: language.t("common.search.placeholder"), autofocus: true }}
        emptyMessage="No skills found."
        key={(x) => x?.name ?? ""}
        items={skills}
        filterKeys={["name", "description"]}
        sortBy={(a, b) => a.name.localeCompare(b.name)}
      >
        {(skill) => (
          <div class="w-full flex items-center justify-between gap-x-3">
            <div class="flex flex-col gap-0.5 min-w-0">
              <div class="flex items-center gap-2">
                <span class="truncate text-13-regular text-text-strong">/{skill.name}</span>
                <span class="text-11-regular text-text-subtle px-1.5 py-0.5 bg-surface-base rounded shrink-0">
                  {language.t("prompt.slash.badge.skill")}
                </span>
              </div>
              <Show when={skill.description}>
                <span class="text-12-regular text-text-weak truncate">{skill.description}</span>
              </Show>
            </div>
          </div>
        )}
      </List>
    </Dialog>
  )
}
