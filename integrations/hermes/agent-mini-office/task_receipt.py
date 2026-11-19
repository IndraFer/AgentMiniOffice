"""Only a deliberately marked, single-line task note is eligible for the member board."""


def instructions(task):
    return (
        "Follow normal Hermes approval rules. For office members, give a one-line outcome "
        "(up to 400 characters; no secrets, paths, conversation excerpts or tool logs). "
        f"If blocked, end with PANEL-TASK-REASON: <reason> followed by PANEL-TASK-FAILED {task} on its own line. "
        "Only if completed, end with PANEL-TASK-SUMMARY: <summary> followed by this exact final line:\n"
        f"PANEL-TASK-DONE {task}"
    )


def receipt(answer, task):
    lines = answer.rstrip().replace("\r\n", "\n").rsplit("\n", 2)
    if lines[-1] == "PANEL-TASK-DONE " + task:
        status, prefix = "ack", "PANEL-TASK-SUMMARY: "
    elif lines[-1] == "PANEL-TASK-FAILED " + task:
        status, prefix = "fail", "PANEL-TASK-REASON: "
    else:
        return "", ""
    note = (
        lines[-2][len(prefix) :].strip()
        if len(lines) > 1 and lines[-2].startswith(prefix)
        else ""
    )
    if not (0 < len(note) <= 400 and note.isprintable()):
        note = ""
    if status == "fail":
        note = (
            "Agent reported: " + note
            if note
            else "The agent reported that it could not complete this task."
        )
    return status, note
