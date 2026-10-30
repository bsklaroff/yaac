# yaac: fish startup in a containerless workspace (docs/containerless-driver.md
# "Shell startup"), reached through XDG_DATA_DIRS. fish runs this before the
# user's config.fish, which may therefore change yaac's environment. It shows
# the checkout as `~workspace` in prompts that use prompt_pwd.
if set -q YAAC_WORKSPACE_DIR; and functions -q prompt_pwd; and not functions -q __yaac_prompt_pwd
    functions -c prompt_pwd __yaac_prompt_pwd
    function prompt_pwd
        if test "$PWD" = "$YAAC_WORKSPACE_DIR"; or string match -q -- "$YAAC_WORKSPACE_DIR/*" "$PWD"
            echo "~workspace"(string sub -s (math (string length -- "$YAAC_WORKSPACE_DIR") + 1) -- "$PWD")
        else
            __yaac_prompt_pwd $argv
        end
    end
end
