import CodeEditor from "@uiw/react-textarea-code-editor";
import EasyModal, { type InnerModalProps } from "ez-modal-react";
import { Field, Form, Formik } from "formik";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Alert } from "react-bootstrap";
import Modal from "react-bootstrap/Modal";
import { checkStackEnv, composerizeStack, type StackEnvVariable } from "src/api/backend";
import { Button, Loading } from "src/components";
import { useSetStack, useStack } from "src/hooks";
import { intl, T } from "src/locale";
import { showError, showObjectSuccess } from "src/notifications";

const showStackModal = (id: number | "new") => {
	EasyModal.show(StackModal, { id });
};

interface Props extends InnerModalProps {
	id: number | "new";
}

const editorStyle = {
	fontFamily: "ui-monospace,SFMono-Regular,SF Mono,Consolas,Liberation Mono,Menlo,monospace",
	borderRadius: "0.3rem",
	backgroundColor: "var(--tblr-bg-surface-dark)",
};

/**
 * The variables the compose file uses, checked against the .env being written,
 * as the user types — so a missing required value shows before saving rather
 * than as a refusal or a failed deploy.
 */
function EnvCheck({ compose, env }: { compose: string; env: string }) {
	const [vars, setVars] = useState<StackEnvVariable[]>([]);
	useEffect(() => {
		const t = setTimeout(() => {
			checkStackEnv(compose, env)
				.then((r) => setVars(r.variables))
				.catch(() => setVars([]));
		}, 400);
		return () => clearTimeout(t);
	}, [compose, env]);
	const required = vars.filter((v) => v.missing && v.required).map((v) => v.name);
	const optional = vars.filter((v) => v.missing && !v.required).map((v) => v.name);
	if (!required.length && !optional.length) return null;
	return (
		<div className="small mt-2">
			{required.length > 0 && (
				<div className="text-danger">
					<T id="stack.env.check.required" data={{ names: required.join(", ") }} />
				</div>
			)}
			{optional.length > 0 && (
				<div className="text-secondary">
					<T id="stack.env.check.optional" data={{ names: optional.join(", ") }} />
				</div>
			)}
		</div>
	);
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
	const envUpload = useRef<HTMLInputElement>(null);

	const onSubmit = async (values: any) => {
		if (isSubmitting) return;
		setIsSubmitting(true);
		setErrorMsg(null);

		const payload = {
			id: id === "new" ? undefined : (id as number),
			name: values.name,
			composeFileName: values.composeFileName,
			composeContent: values.composeContent,
			// Only on create; an existing stack's .env has its own editor.
			envContent: id === "new" && values.envContent ? values.envContent : undefined,
		};

		setStack(payload, {
			onError: (err: any) => setErrorMsg(err.message),
			onSuccess: (result: any) => {
				showObjectSuccess("stack", "saved");
				if (result?.missingRequired?.length) {
					showError(
						intl.formatMessage(
							{ id: "stack.env.saved-missing" },
							{ names: result.missingRequired.join(", ") },
						),
					);
				}
				remove();
			},
			onSettled: () => setIsSubmitting(false),
		});
	};

	return (
		// scrollable: the body scrolls inside the window; the editors scroll inside the body
		<Modal show={visible} onHide={remove} size="lg" scrollable>
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
							envContent: "",
						} as any
					}
					onSubmit={onSubmit}
				>
					{({ setFieldValue, values }: any) => (
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
											{/* The editor grows with its content; this box keeps it to part
											    of the window and scrolls instead of the whole modal. */}
											<div
												style={{ maxHeight: "50vh", overflowY: "auto", borderRadius: "0.3rem" }}
											>
												<CodeEditor
													language="yaml"
													padding={15}
													data-color-mode="dark"
													minHeight={300}
													indentWidth={2}
													style={{ ...editorStyle, minHeight: "300px" }}
													{...field}
												/>
											</div>
										</div>
									)}
								</Field>

								{!data?.id && (
									<Field name="envContent">
										{({ field }: any) => (
											<div className="mt-3">
												<div className="d-flex align-items-center mb-1">
													<label className="form-label mb-0 me-auto" htmlFor="envContent">
														<T id="stack.env.file" />
													</label>
													<input
														ref={envUpload}
														type="file"
														className="d-none"
														onChange={async (e) => {
															const file = e.target.files?.[0];
															if (file) setFieldValue("envContent", await file.text());
															e.target.value = "";
														}}
													/>
													<Button size="sm" onClick={() => envUpload.current?.click()}>
														<T id="stack.env.upload" />
													</Button>
												</div>
												<div
													style={{
														maxHeight: "25vh",
														overflowY: "auto",
														borderRadius: "0.3rem",
													}}
												>
													<CodeEditor
														id="envContent"
														language="bash"
														padding={15}
														data-color-mode="dark"
														minHeight={90}
														placeholder="DB_PASSWORD=..."
														style={{ ...editorStyle, minHeight: "90px" }}
														{...field}
													/>
												</div>
												<small className="form-hint">
													<T id="stack.env.file.help" />
												</small>
											</div>
										)}
									</Field>
								)}
								{!data?.id && <EnvCheck compose={values.composeContent} env={values.envContent} />}
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
