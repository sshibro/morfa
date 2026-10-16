// Comments in "Morfa" (docs/design-tool.md §Teams "Comments"): what the editor's chunk carries. The tool registers itself on
// import (one feature line in DesignEditor.tsx); the controller polls the file's comments through the feed (feed.ts, the hook for a
// real-time channel); the UI is in ./ui, loaded with the first use of comment mode or the "Comments" tab.
import {registerCommentTool} from './tool';

registerCommentTool();

export {commentToolHost, createCommentsController, unreadOf, type CommentsController, type CommentsState} from './controller';
export {COMMENT_TOOL, connectCommentTool} from './tool';
export {followCommentLinks, linkedThreadId} from './links';
export {setCommentFeed, type CommentFeed, type CommentFeedTarget} from './feed';
