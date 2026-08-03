import CodeEditor from "@uiw/react-textarea-code-editor";
import EasyModal, { type InnerModalProps } from "ez-modal-react";
import { Field, Form, Formik } from "formik";
import { type ReactNode, useState } from "react";
import { Alert } from "react-bootstrap";
import Modal from "react-bootstrap/Modal";
import { composerizeStack } from "src/api/backend";
import { Button, Loading } from "src/components";
import { useSetStack, useStack } from "src/hooks";
import { T } from "src/locale";
import { showObjectSuccess } from "src/notifications";

const showStackModal = (id: number | "new") => {
	EasyModal.show(StackModal, { id });
};

interface Props extends InnerModalProps {
	id: number | "new";
}

const validateName = (value: string) => {
	if (!value) return "Name is required";
	if (!/^[a-z0-9_-]+$/.test(value)) return "Only lowercase letters, numbers, hyphens and underscores";
	return undefined;
};

const StackModal = EasyModal.create(({ id, visible, remove }: Props) => {
	const { data, isLoading, error } = useStack(id);
	const { mutate: setStack } = useSetStack();
	const [errorMsg, setErrorMsg] = useState<ReactNode | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);

	const onSubmit = async (values: any) => {
		if (isSubmitting) return;
		setIsSubmitting(true);
		setErrorMsg(null);

		const payload = {
			id: id === "new" ? undefined : (id as number),
			name: values.name,
			composeFileName: values.composeFileName,
			composeContent: values.composeContent,
		};

		setStack(payload, {
			onError: (err: any) => setErrorMsg(err.message),
			onSuccess: () => {
				showObjectSuccess("stack", "saved");
				remove();
			},
			onSettled: () => setIsSubmitting(false),
		});
	};

	return (
		<Modal show={visible} onHide={remove} size="lg">
			{!isLoading && error && (
				<Alert variant="danger" className="m-3">
					{error?.message || "Unknown error"}
				</Alert>
			)}
			{isLoading && <Loading noLogo />}
			{!isLoading && data && (
				<Formik
					initialValues={
						{
							name: data?.name || "",
							composeFileName: data?.composeFileName || "compose.yaml",
							composeContent: data?.composeContent || "",
						} as any
					}
					onSubmit={onSubmit}
				>
					{({ setFieldValue }: any) => (
						<Form>
							<Modal.Header closeButton>
								<Modal.Title>
									<T id={data?.id ? "object.edit" : "object.add"} tData={{ object: "stack" }} />
								</Modal.Title>
							</Modal.Header>
							<Modal.Body>
								<Alert variant="danger" show={!!errorMsg} onClose={() => setErrorMsg(null)} dismissible>
									{errorMsg}
								</Alert>

								<Field name="name" validate={data?.id ? undefined : validateName}>
									{({ field, form }: any) => (
										<div className="mb-3">
											<label className="form-label" htmlFor="name">
												<T id="stack.name" />
											</label>
											<input
												id="name"
												type="text"
												className={`form-control ${form.errors.name && form.touched.name ? "is-invalid" : ""}`}
												placeholder="my-app"
												disabled={!!data?.id}
												{...field}
											/>
											{form.errors.name && form.touched.name ? (
												<div className="invalid-feedback">{form.errors.name}</div>
											) : (
												<small className="form-hint">
													<T id="stack.name.hint" />
												</small>
											)}
										</div>
									)}
								</Field>

								<Field name="composeContent">
									{({ field }: any) => (
										<div className="mb-1">
											<div className="d-flex align-items-center mb-1">
												<label className="form-label mb-0 me-auto" htmlFor="composeContent">
													<T id="stack.compose" />
												</label>
												<Button
													size="sm"
													onClick={async () => {
														const cmd = window.prompt(
															"Paste a `docker run ...` command to convert:",
														);
														if (!cmd) return;
														try {
															const yaml = await composerizeStack(cmd);
															setFieldValue("composeContent", yaml);
														} catch (err: any) {
															setErrorMsg(err.message || "Convert failed");
														}
													}}
												>
													<T id="stack.import-run" />
												</Button>
											</div>
											<CodeEditor
												language="yaml"
												padding={15}
												data-color-mode="dark"
												minHeight={300}
												indentWidth={2}
												style={{
													fontFamily:
														"ui-monospace,SFMono-Regular,SF Mono,Consolas,Liberation Mono,Menlo,monospace",
													borderRadius: "0.3rem",
													minHeight: "300px",
													backgroundColor: "var(--tblr-bg-surface-dark)",
												}}
												{...field}
											/>
										</div>
									)}
								</Field>
							</Modal.Body>
							<Modal.Footer>
								<Button data-bs-dismiss="modal" onClick={remove} disabled={isSubmitting}>
									<T id="cancel" />
								</Button>
								<Button
									type="submit"
									actionType="primary"
									className="ms-auto"
									isLoading={isSubmitting}
									disabled={isSubmitting}
								>
									<T id="save" />
								</Button>
							</Modal.Footer>
						</Form>
					)}
				</Formik>
			)}
		</Modal>
	);
});

export { showStackModal };
