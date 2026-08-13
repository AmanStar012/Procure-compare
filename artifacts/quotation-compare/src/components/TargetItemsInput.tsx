import { useState, type KeyboardEvent } from "react"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { X } from "lucide-react"

interface Props {
  value: string[]
  onChange: (items: string[]) => void
  autoFocus?: boolean
}

export function TargetItemsInput({ value, onChange, autoFocus }: Props) {
  const [categoryInput, setCategoryInput] = useState("")

  const addCategory = () => {
    const trimmed = categoryInput.trim()
    if (!trimmed) return
    if (!value.some((t) => t.toLowerCase() === trimmed.toLowerCase())) {
      onChange([...value, trimmed])
    }
    setCategoryInput("")
  }

  const removeCategory = (item: string) => {
    onChange(value.filter((t) => t !== item))
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault()
      addCategory()
    } else if (e.key === "Backspace" && categoryInput === "" && value.length > 0) {
      onChange(value.slice(0, -1))
    }
  }

  return (
    <div className="space-y-2">
      <Input
        placeholder="Type a category and press Enter"
        value={categoryInput}
        onChange={(e) => setCategoryInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={addCategory}
        autoFocus={autoFocus}
      />
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {value.map((item) => (
            <Badge key={item} variant="secondary" className="gap-1 pr-1">
              {item}
              <button
                type="button"
                onClick={() => removeCategory(item)}
                className="rounded-full hover:bg-muted-foreground/20 p-0.5"
                aria-label={`Remove ${item}`}
              >
                <X className="w-3 h-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  )
}
