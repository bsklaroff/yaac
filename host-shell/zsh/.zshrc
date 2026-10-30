# yaac: see .zshenv. Also names the checkout `~workspace` for prompts.
# macOS's /etc/zshrc names HISTFILE after ZDOTDIR, which pointed here then.
[[ $HISTFILE == ${_yaac_zdotdir}/* ]] && HISTFILE=$_yaac_user_zdotdir/${HISTFILE:t}
ZDOTDIR=$_yaac_user_zdotdir
[[ -r $ZDOTDIR/.zshrc ]] && . $ZDOTDIR/.zshrc
_yaac_user_zdotdir=$ZDOTDIR
. $YAAC_SHELL_ENV
hash -d workspace=$YAAC_WORKSPACE_DIR
