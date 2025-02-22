/**
 * External dependencies
 */
import classnames from 'classnames';

/**
 * WordPress dependencies
 */
import {
	useRef,
	useCallback,
	forwardRef,
	createContext,
} from '@wordpress/element';
import { useDispatch, useSelect } from '@wordpress/data';
import { useMergeRefs, useInstanceId } from '@wordpress/compose';
import {
	__unstableUseRichText as useRichText,
	removeFormat,
} from '@wordpress/rich-text';
import { Popover } from '@wordpress/components';
import { getBlockType, store as blocksStore } from '@wordpress/blocks';

/**
 * Internal dependencies
 */
import { useBlockEditorAutocompleteProps } from '../autocomplete';
import { useBlockEditContext } from '../block-edit';
import { blockBindingsKey } from '../block-edit/context';
import FormatToolbarContainer from './format-toolbar-container';
import { store as blockEditorStore } from '../../store';
import { useUndoAutomaticChange } from './use-undo-automatic-change';
import { useMarkPersistent } from './use-mark-persistent';
import { usePasteHandler } from './use-paste-handler';
import { useBeforeInputRules } from './use-before-input-rules';
import { useInputRules } from './use-input-rules';
import { useDelete } from './use-delete';
import { useEnter } from './use-enter';
import { useFormatTypes } from './use-format-types';
import { useRemoveBrowserShortcuts } from './use-remove-browser-shortcuts';
import { useShortcuts } from './use-shortcuts';
import { useInputEvents } from './use-input-events';
import { useInsertReplacementText } from './use-insert-replacement-text';
import { useFirefoxCompat } from './use-firefox-compat';
import FormatEdit from './format-edit';
import { getAllowedFormats } from './utils';
import { Content } from './content';
import { withDeprecations } from './with-deprecations';
import { unlock } from '../../lock-unlock';
import { canBindBlock } from '../../hooks/use-bindings-attributes';

export const keyboardShortcutContext = createContext();
export const inputEventContext = createContext();

const instanceIdKey = Symbol( 'instanceId' );

/**
 * Removes props used for the native version of RichText so that they are not
 * passed to the DOM element and log warnings.
 *
 * @param {Object} props Props to filter.
 *
 * @return {Object} Filtered props.
 */
function removeNativeProps( props ) {
	const {
		__unstableMobileNoFocusOnMount,
		deleteEnter,
		placeholderTextColor,
		textAlign,
		selectionColor,
		tagsToEliminate,
		disableEditingMenu,
		fontSize,
		fontFamily,
		fontWeight,
		fontStyle,
		minWidth,
		maxWidth,
		disableSuggestions,
		disableAutocorrection,
		...restProps
	} = props;
	return restProps;
}

export function RichTextWrapper(
	{
		children,
		tagName = 'div',
		value: adjustedValue = '',
		onChange: adjustedOnChange,
		isSelected: originalIsSelected,
		multiline,
		inlineToolbar,
		wrapperClassName,
		autocompleters,
		onReplace,
		placeholder,
		allowedFormats,
		withoutInteractiveFormatting,
		onRemove,
		onMerge,
		onSplit,
		__unstableOnSplitAtEnd: onSplitAtEnd,
		__unstableOnSplitAtDoubleLineEnd: onSplitAtDoubleLineEnd,
		identifier,
		preserveWhiteSpace,
		__unstablePastePlainText: pastePlainText,
		__unstableEmbedURLOnPaste,
		__unstableDisableFormats: disableFormats,
		disableLineBreaks,
		__unstableAllowPrefixTransformations,
		disableEditing,
		...props
	},
	forwardedRef
) {
	props = removeNativeProps( props );

	const instanceId = useInstanceId( RichTextWrapper );

	const anchorRef = useRef();
	const context = useBlockEditContext();
	const { clientId, isSelected: isBlockSelected, name: blockName } = context;
	const blockBindings = context[ blockBindingsKey ];
	const selector = ( select ) => {
		// Avoid subscribing to the block editor store if the block is not
		// selected.
		if ( ! isBlockSelected ) {
			return { isSelected: false };
		}

		const { getSelectionStart, getSelectionEnd } =
			select( blockEditorStore );
		const selectionStart = getSelectionStart();
		const selectionEnd = getSelectionEnd();

		let isSelected;

		if ( originalIsSelected === undefined ) {
			isSelected =
				selectionStart.clientId === clientId &&
				selectionEnd.clientId === clientId &&
				( identifier
					? selectionStart.attributeKey === identifier
					: selectionStart[ instanceIdKey ] === instanceId );
		} else if ( originalIsSelected ) {
			isSelected = selectionStart.clientId === clientId;
		}

		return {
			selectionStart: isSelected ? selectionStart.offset : undefined,
			selectionEnd: isSelected ? selectionEnd.offset : undefined,
			isSelected,
		};
	};
	const { selectionStart, selectionEnd, isSelected } = useSelect( selector, [
		clientId,
		identifier,
		instanceId,
		originalIsSelected,
		isBlockSelected,
	] );

	const disableBoundBlocks = useSelect(
		( select ) => {
			// Disable Rich Text editing if block bindings specify that.
			let _disableBoundBlocks = false;
			if ( blockBindings && canBindBlock( blockName ) ) {
				const blockTypeAttributes =
					getBlockType( blockName ).attributes;
				const { getBlockBindingsSource } = unlock(
					select( blocksStore )
				);
				for ( const [ attribute, args ] of Object.entries(
					blockBindings
				) ) {
					if (
						blockTypeAttributes?.[ attribute ]?.source !==
						'rich-text'
					) {
						break;
					}

					// If the source is not defined, or if its value of `lockAttributesEditing` is `true`, disable it.
					const blockBindingsSource = getBlockBindingsSource(
						args.source
					);
					if (
						! blockBindingsSource ||
						blockBindingsSource.lockAttributesEditing
					) {
						_disableBoundBlocks = true;
						break;
					}
				}
			}

			return _disableBoundBlocks;
		},
		[ blockBindings, blockName ]
	);

	const shouldDisableEditing = disableEditing || disableBoundBlocks;

	const { getSelectionStart, getSelectionEnd, getBlockRootClientId } =
		useSelect( blockEditorStore );
	const { selectionChange } = useDispatch( blockEditorStore );
	const adjustedAllowedFormats = getAllowedFormats( {
		allowedFormats,
		disableFormats,
	} );
	const hasFormats =
		! adjustedAllowedFormats || adjustedAllowedFormats.length > 0;

	const onSelectionChange = useCallback(
		( start, end ) => {
			const selection = {};
			const unset = start === undefined && end === undefined;

			const baseSelection = {
				clientId,
				[ identifier ? 'attributeKey' : instanceIdKey ]: identifier
					? identifier
					: instanceId,
			};

			if ( typeof start === 'number' || unset ) {
				// If we are only setting the start (or the end below), which
				// means a partial selection, and we're not updating a selection
				// with the same client ID, abort. This means the selected block
				// is a parent block.
				if (
					end === undefined &&
					getBlockRootClientId( clientId ) !==
						getBlockRootClientId( getSelectionEnd().clientId )
				) {
					return;
				}

				selection.start = {
					...baseSelection,
					offset: start,
				};
			}

			if ( typeof end === 'number' || unset ) {
				if (
					start === undefined &&
					getBlockRootClientId( clientId ) !==
						getBlockRootClientId( getSelectionStart().clientId )
				) {
					return;
				}

				selection.end = {
					...baseSelection,
					offset: end,
				};
			}

			selectionChange( selection );
		},
		[
			clientId,
			getBlockRootClientId,
			getSelectionEnd,
			getSelectionStart,
			identifier,
			instanceId,
			selectionChange,
		]
	);

	const {
		formatTypes,
		prepareHandlers,
		valueHandlers,
		changeHandlers,
		dependencies,
	} = useFormatTypes( {
		clientId,
		identifier,
		withoutInteractiveFormatting,
		allowedFormats: adjustedAllowedFormats,
	} );

	function addEditorOnlyFormats( value ) {
		return valueHandlers.reduce(
			( accumulator, fn ) => fn( accumulator, value.text ),
			value.formats
		);
	}

	function removeEditorOnlyFormats( value ) {
		formatTypes.forEach( ( formatType ) => {
			// Remove formats created by prepareEditableTree, because they are editor only.
			if ( formatType.__experimentalCreatePrepareEditableTree ) {
				value = removeFormat(
					value,
					formatType.name,
					0,
					value.text.length
				);
			}
		} );

		return value.formats;
	}

	function addInvisibleFormats( value ) {
		return prepareHandlers.reduce(
			( accumulator, fn ) => fn( accumulator, value.text ),
			value.formats
		);
	}

	const {
		value,
		getValue,
		onChange,
		ref: richTextRef,
	} = useRichText( {
		value: adjustedValue,
		onChange( html, { __unstableFormats, __unstableText } ) {
			adjustedOnChange( html );
			Object.values( changeHandlers ).forEach( ( changeHandler ) => {
				changeHandler( __unstableFormats, __unstableText );
			} );
		},
		selectionStart,
		selectionEnd,
		onSelectionChange,
		placeholder,
		__unstableIsSelected: isSelected,
		__unstableDisableFormats: disableFormats,
		preserveWhiteSpace,
		__unstableDependencies: [ ...dependencies, tagName ],
		__unstableAfterParse: addEditorOnlyFormats,
		__unstableBeforeSerialize: removeEditorOnlyFormats,
		__unstableAddInvisibleFormats: addInvisibleFormats,
	} );
	const autocompleteProps = useBlockEditorAutocompleteProps( {
		onReplace,
		completers: autocompleters,
		record: value,
		onChange,
	} );

	useMarkPersistent( { html: adjustedValue, value } );

	const keyboardShortcuts = useRef( new Set() );
	const inputEvents = useRef( new Set() );

	function onFocus() {
		anchorRef.current?.focus();
	}

	const TagName = tagName;
	return (
		<>
			{ isSelected && (
				<keyboardShortcutContext.Provider value={ keyboardShortcuts }>
					<inputEventContext.Provider value={ inputEvents }>
						<Popover.__unstableSlotNameProvider value="__unstable-block-tools-after">
							{ children &&
								children( { value, onChange, onFocus } ) }

							<FormatEdit
								value={ value }
								onChange={ onChange }
								onFocus={ onFocus }
								formatTypes={ formatTypes }
								forwardedRef={ anchorRef }
							/>
						</Popover.__unstableSlotNameProvider>
					</inputEventContext.Provider>
				</keyboardShortcutContext.Provider>
			) }
			{ isSelected && hasFormats && (
				<FormatToolbarContainer
					inline={ inlineToolbar }
					editableContentElement={ anchorRef.current }
				/>
			) }
			<TagName
				// Overridable props.
				role="textbox"
				aria-multiline={ ! disableLineBreaks }
				aria-label={ placeholder }
				aria-readonly={ shouldDisableEditing }
				{ ...props }
				{ ...autocompleteProps }
				ref={ useMergeRefs( [
					// Rich text ref must be first because its focus listener
					// must be set up before any other ref calls .focus() on
					// mount.
					richTextRef,
					forwardedRef,
					autocompleteProps.ref,
					props.ref,
					useBeforeInputRules( { value, onChange } ),
					useInputRules( {
						getValue,
						onChange,
						__unstableAllowPrefixTransformations,
						formatTypes,
						onReplace,
						selectionChange,
					} ),
					useInsertReplacementText(),
					useRemoveBrowserShortcuts(),
					useShortcuts( keyboardShortcuts ),
					useInputEvents( inputEvents ),
					useUndoAutomaticChange(),
					usePasteHandler( {
						isSelected,
						disableFormats,
						onChange,
						value,
						formatTypes,
						tagName,
						onReplace,
						onSplit,
						__unstableEmbedURLOnPaste,
						pastePlainText,
					} ),
					useDelete( {
						value,
						onMerge,
						onRemove,
					} ),
					useEnter( {
						removeEditorOnlyFormats,
						value,
						onReplace,
						onSplit,
						onChange,
						disableLineBreaks,
						onSplitAtEnd,
						onSplitAtDoubleLineEnd,
					} ),
					useFirefoxCompat(),
					anchorRef,
				] ) }
				contentEditable={ ! shouldDisableEditing }
				suppressContentEditableWarning
				className={ classnames(
					'block-editor-rich-text__editable',
					props.className,
					'rich-text'
				) }
				// Setting tabIndex to 0 is unnecessary, the element is already
				// focusable because it's contentEditable. This also fixes a
				// Safari bug where it's not possible to Shift+Click multi
				// select blocks when Shift Clicking into an element with
				// tabIndex because Safari will focus the element. However,
				// Safari will correctly ignore nested contentEditable elements.
				tabIndex={
					props.tabIndex === 0 && ! shouldDisableEditing
						? null
						: props.tabIndex
				}
				data-wp-block-attribute-key={ identifier }
			/>
		</>
	);
}

// This is the private API for the RichText component.
// It allows access to all props, not just the public ones.
export const PrivateRichText = withDeprecations(
	forwardRef( RichTextWrapper )
);

PrivateRichText.Content = Content;
PrivateRichText.isEmpty = ( value ) => {
	return ! value || value.length === 0;
};

// This is the public API for the RichText component.
// We wrap the PrivateRichText component to hide some props from the public API.
/**
 * @see https://github.com/WordPress/gutenberg/blob/HEAD/packages/block-editor/src/components/rich-text/README.md
 */
const PublicForwardedRichTextContainer = forwardRef( ( props, ref ) => {
	return (
		<PrivateRichText ref={ ref } { ...props } disableEditing={ false } />
	);
} );

PublicForwardedRichTextContainer.Content = Content;
PublicForwardedRichTextContainer.isEmpty = ( value ) => {
	return ! value || value.length === 0;
};

export default PublicForwardedRichTextContainer;
export { RichTextShortcut } from './shortcut';
export { RichTextToolbarButton } from './toolbar-button';
export { __unstableRichTextInputEvent } from './input-event';
